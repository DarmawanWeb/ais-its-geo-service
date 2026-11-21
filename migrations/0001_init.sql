-- 0001_init — initial schema of ais-its-geo-service (docs/PLATFORM_SPEC.md §6, §13.6).
--
-- Runs inside the service schema ("geo"; search_path=<schema>,public) as the
-- role geo_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0002_<change>.sql instead.
-- Object names are unqualified and the schema is read from current_schema(),
-- so the same file provisions any schema name (integration tests use several).

DO $comment$
BEGIN
  EXECUTE format('COMMENT ON SCHEMA %I IS %L', current_schema(),
                 'geo service: zones/geofences registry - owned by geo_svc');
END
$comment$;

-- -----------------------------------------------------------------------------
-- Zones (geofences) — ZoneSnapshotV1 of contracts is their published state.
-- -----------------------------------------------------------------------------
CREATE TABLE zones (
  id             uuid PRIMARY KEY,
  -- Owning organization; NULL = global zone (shared by every tenant, spec §8.5).
  org_id         uuid,
  -- Stable code: lowercase slug, unique per owner (global zones share one namespace).
  code           text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind           text NOT NULL CHECK (kind IN ('pipeline', 'transhipment_area', 'fishing_ground',
                                               'mpa', 'restricted', 'anchorage', 'port',
                                               'tss_lane', 'shallow_water', 'custom')),
  -- WGS84, 2-D. Validated by the service (GeoJSON structure, geometry type per kind,
  -- <= 50 000 vertices, ST_IsValid); the CHECK is the last line of defence and the
  -- service never applies ST_MakeValid on its own.
  geom           geography(Geometry, 4326) NOT NULL
                   CONSTRAINT zones_geom_valid CHECK (ST_IsValid(geom::geometry)),
  -- Buffer around the geometry, meters (e.g. 1 750 for the pipeline corridor).
  buffer_m       double precision NOT NULL DEFAULT 0 CHECK (buffer_m >= 0 AND buffer_m <= 100000),
  alert_on_enter boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  -- Kind-specific properties (contracts ZONE_PROPERTY_SCHEMAS), e.g. pipeline KP markers.
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  -- Provenance of the geometry (dataset, survey, regulation).
  source         text CHECK (char_length(source) BETWEEN 1 AND 500),
  -- User who created the zone; NULL for seeds and other system writes.
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One code per owner; NULLS NOT DISTINCT makes global codes unique as well.
  CONSTRAINT zones_org_code_key UNIQUE NULLS NOT DISTINCT (org_id, code)
);

COMMENT ON TABLE zones IS 'Zones and geofences (spec §13.6); org_id NULL = global zone.';

-- bbox queries compare in lon/lat geometry space (kit geographyIntersectsBBox).
CREATE INDEX zones_geom_gist ON zones USING gist ((geom::geometry));
-- Tenancy scopes and filters: (org_id IS NULL OR org_id = $org) AND kind = …
CREATE INDEX zones_org_kind_idx ON zones (org_id, kind);
CREATE INDEX zones_kind_active_idx ON zones (kind, active);

-- -----------------------------------------------------------------------------
-- Transactional outbox (spec §7, §13.6): ZoneSnapshotV1 / ZoneDeletedV1 and the
-- audit records of zone changes are inserted in the transaction of the change
-- and published by the relay (FOR UPDATE SKIP LOCKED, per-key order by seq).
-- The columns of the kit's outboxTableSql() (rows are written with the kit's
-- enqueueEvent) plus seq, ordering_key and next_attempt_at.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
  -- Envelope id = Nats-Msg-Id (JetStream deduplication of relay retries).
  id              uuid PRIMARY KEY,
  -- Insertion order from the database, independent of application clocks.
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  type            text NOT NULL,
  -- Envelope subject: the zone id of geo events, the target of audit records.
  entity_key      text,
  -- Rows of one key publish one after the other in seq order: per zone for the
  -- compacted GEO stream (latest snapshot wins), per target for audit records.
  ordering_key    text GENERATED ALWAYS AS
                    (split_part(type, '.', 1) || ':' || coalesce(entity_key, id::text)) STORED,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  -- Retry backoff after a failed publication (NULL = publish as soon as possible).
  next_attempt_at timestamptz,
  published_at    timestamptz,
  -- Set for rows that can never be published (invalid payload, too large).
  failed_at       timestamptz
);

COMMENT ON TABLE outbox IS 'Transactional outbox of the GEO and AUDIT events (relay: FOR UPDATE SKIP LOCKED).';

-- Head-of-line lookup: the oldest pending row per ordering key.
CREATE INDEX outbox_pending_key_idx ON outbox (ordering_key, seq)
  WHERE published_at IS NULL AND failed_at IS NULL;
-- Backlog metrics and the relay's batch order.
CREATE INDEX outbox_pending_seq_idx ON outbox (seq)
  WHERE published_at IS NULL AND failed_at IS NULL;
-- Retention cleanup of published rows.
CREATE INDEX outbox_published_at_idx ON outbox (published_at)
  WHERE published_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Vector tiles (Martin, read-only role tiles_ro, spec §6): global active zones
-- only, because Martin cannot apply tenancy; organization zones reach the map
-- through the authenticated GET /api/v2/zones/geojson. security_barrier keeps
-- the tenancy filter ahead of any predicate a tiles_ro query adds.
-- -----------------------------------------------------------------------------
CREATE VIEW zones_tiles WITH (security_barrier = true) AS
SELECT id,
       code,
       name,
       kind,
       buffer_m,
       alert_on_enter,
       updated_at,
       geom::geometry(Geometry, 4326) AS geom
  FROM zones
 WHERE org_id IS NULL
   AND active;

COMMENT ON VIEW zones_tiles IS 'Global active zones for Martin vector tiles (SELECT granted to tiles_ro when present).';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO tiles_ro', current_schema());
    EXECUTE format('GRANT SELECT ON %I.zones_tiles TO tiles_ro', current_schema());
  END IF;
END
$grant$;
