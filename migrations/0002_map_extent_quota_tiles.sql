-- 0002_map_extent_quota_tiles — bbox queries that honour zone buffers, stored
-- vertex counts (map budget, quotas) and an index-backed Martin source.
--
-- Same conventions as 0001_init.sql: runs inside the service schema as geo_svc
-- in one transaction, unqualified names, forward-only (never edit once applied).
-- Generated columns are computed by the functions below when a row is written;
-- after changing such a function in a later migration, recompute the stored
-- values with `UPDATE zones SET geom = geom`.

-- -----------------------------------------------------------------------------
-- Buffered extent. A zone covers every point within buffer_m meters of its
-- geometry (a point zone is a circle). bbox filters compare in lon/lat
-- degrees, so the buffer is converted to a conservative radius in degrees:
-- large enough in latitude (meridian degree >= 110 574.27 m on WGS84) and in
-- longitude at the most poleward latitude the buffered zone reaches (parallel
-- degree >= 111 319.49 m x cos(lat)), plus 1 % for the spherical
-- approximation. Within 1 degree of a pole every longitude matches.
-- Unit: degrees. Sources: NIMA TR8350.2 (WGS 84 a = 6 378 137 m).
-- -----------------------------------------------------------------------------
CREATE FUNCTION zone_buffer_degrees(geom geography, buffer_m double precision)
  RETURNS double precision
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE
  WHEN buffer_m <= 0 THEN 0::double precision
  ELSE (
    SELECT CASE
             WHEN lat.phi >= 89 THEN 360::double precision
             ELSE least(360::double precision,
                        1.01 * greatest(buffer_m / 110574.2696,
                                        buffer_m / (111319.4908 * cosd(lat.phi))))
           END
      FROM (SELECT least(90::double precision,
                         greatest(abs(ST_YMin(geom::geometry)), abs(ST_YMax(geom::geometry)))
                           + buffer_m / 110574.2696) AS phi) AS lat)
END;

COMMENT ON FUNCTION zone_buffer_degrees(geography, double precision) IS
  'Conservative radius in degrees covering buffer_m meters around the zone geometry (bbox filters).';

-- The lon/lat box of the geometry expanded by zone_buffer_degrees; a box that
-- would cross the antimeridian spans every longitude instead.
CREATE FUNCTION zone_extent(geom geography, buffer_m double precision)
  RETURNS geometry
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN (
  SELECT ST_MakeEnvelope(
           CASE WHEN e.wraps THEN -180 ELSE e.xmin - e.r END,
           greatest(-90, e.ymin - e.r),
           CASE WHEN e.wraps THEN 180 ELSE e.xmax + e.r END,
           least(90, e.ymax + e.r),
           4326)
    FROM (SELECT b.*, (b.xmin - b.r < -180 OR b.xmax + b.r > 180) AS wraps
            FROM (SELECT ST_XMin(s.g) AS xmin, ST_YMin(s.g) AS ymin,
                         ST_XMax(s.g) AS xmax, ST_YMax(s.g) AS ymax,
                         zone_buffer_degrees(geom, buffer_m) AS r
                    FROM (SELECT geom::geometry AS g) AS s) AS b) AS e);

COMMENT ON FUNCTION zone_extent(geography, double precision) IS
  'Lon/lat box of the zone geometry expanded by its buffer (index of bbox filters).';

ALTER TABLE zones
  -- Vertices of the geometry (ST_NPoints): the map budget and the quotas read it
  -- without loading geometries.
  ADD COLUMN vertex_count integer NOT NULL
    GENERATED ALWAYS AS (ST_NPoints(geom::geometry)) STORED,
  -- Lon/lat box covering the geometry and its buffer.
  ADD COLUMN extent geometry(Polygon, 4326) NOT NULL
    GENERATED ALWAYS AS (zone_extent(geom, buffer_m)) STORED;

-- bbox filters: extent && box (index), refined on the geometry and the buffer.
CREATE INDEX zones_extent_gist ON zones USING gist (extent);

-- -----------------------------------------------------------------------------
-- Vector tiles. The zones_tiles view stays (spec §6), but its security barrier
-- keeps Martin's `geom && tile` predicate above the scan (PostGIS && is not
-- leakproof), so no index can serve it. zones_tiles_mvt(z, x, y) is a Martin
-- function source with the same rows and columns: it filters the base table
-- (global active zones only) with an index-backed predicate. SECURITY DEFINER
-- (owner geo_svc) because tiles_ro has no privilege on the table; its body is
-- bound at creation (SQL-standard body), so the caller's search_path is moot.
-- -----------------------------------------------------------------------------
CREATE INDEX zones_tiles_geom_gist ON zones USING gist ((geom::geometry))
  WHERE org_id IS NULL AND active;

CREATE FUNCTION zones_tiles_mvt(z integer, x integer, y integer)
  RETURNS bytea
  LANGUAGE sql STABLE STRICT PARALLEL SAFE SECURITY DEFINER
  SET search_path FROM CURRENT
RETURN (
  SELECT coalesce(ST_AsMVT(tile, 'zones_tiles_mvt', 4096, 'geom'), ''::bytea)
    FROM (SELECT zones.id::text AS id,
                 zones.code,
                 zones.name,
                 zones.kind,
                 zones.buffer_m,
                 zones.alert_on_enter,
                 to_char(zones.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
                 ST_AsMVTGeom(ST_Transform(ST_ClipByBox2D(zones.geom::geometry, bounds.envelope), 3857),
                              ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom
            FROM zones,
                 (SELECT ST_Transform(ST_TileEnvelope(z, x, y, margin => 64.0 / 4096), 4326) AS envelope) AS bounds
           WHERE zones.org_id IS NULL
             AND zones.active
             AND zones.geom::geometry && bounds.envelope) AS tile
   WHERE tile.geom IS NOT NULL);

COMMENT ON FUNCTION zones_tiles_mvt(integer, integer, integer) IS
  'Martin function source: MVT tile (layer zones_tiles_mvt) of the global active zones; EXECUTE granted to tiles_ro when present.';

REVOKE ALL ON FUNCTION zones_tiles_mvt(integer, integer, integer) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.zones_tiles_mvt(integer, integer, integer) TO tiles_ro',
                   current_schema());
  END IF;
END
$grant$;
