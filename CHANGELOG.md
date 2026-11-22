# Changelog

All notable changes to `ais-its-geo-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GET /api/v2/zones/geojson` is bounded whatever the data volume: a vertex budget
  `ZONES_GEOJSON_MAX_VERTICES` (default 250 000, counted after simplification) next to
  `ZONES_GEOJSON_MAX_FEATURES`, a `zoom` parameter that simplifies the geometries to half a pixel
  (`ST_SimplifyPreserveTopology`), and a streamed response read from PostgreSQL in chunks of
  ~100 000 stored vertices. New foreign members `truncatedBy`, `vertexLimit`, `featureCount`,
  `vertexCount`, `zoom`, `toleranceDeg`.
- Quotas per owner (each organization; all global zones together): `ZONE_QUOTA_MAX_ZONES`
  (default 1 000) and `ZONE_QUOTA_MAX_VERTICES` (default 2 000 000), checked on create, on
  geometry changes and on seeds under a per-owner advisory lock → `409 ZONE_QUOTA_EXCEEDED`.
- Optimistic concurrency: `ETag` (the quoted `updatedAt`) on `GET /zones/:id`, `POST` and
  `PATCH`; `If-Match` on `PATCH` / `DELETE` → `412 ZONE_VERSION_CONFLICT` when the zone changed.
- Martin function source `zones_tiles_mvt(z, x, y)` (migration `0002`): the global active zones
  as an MVT tile through an index-backed predicate (partial GiST index
  `zones_tiles_geom_gist`), `SECURITY DEFINER`, `EXECUTE` for `tiles_ro` only.
- `TilesGrants`: the `tiles_ro` grants of the tiles sources are re-applied at every start, so a
  role created after the migrations needs no manual step.
- `PublicationLimits`: every zone snapshot is measured against the connected NATS server's
  `max_payload` before the write commits (`422 ZONE_SNAPSHOT_TOO_LARGE`); the service warns at
  startup when the server cannot carry the largest valid zone. README: `max_payload` ≥ 4 MB is a
  deployment requirement.
- Generated columns `vertex_count` and `extent` (buffered lon/lat box, GiST index) and the SQL
  functions `zone_buffer_degrees` / `zone_extent` (migration `0002`).

### Changed

- bbox filters of `GET /zones` and `GET /zones/geojson` match a zone when its buffer reaches the
  box (a point zone is a circle of `bufferM`, a pipeline a corridor), not only its raw geometry.
- `aisits_geo_zone_rejections_total{code}` counts every refused write (400/409/412/422) of
  `POST`/`PATCH`/`DELETE`, the DTO validation of the global `ValidationPipe` included
  (`ZoneRejectionsInterceptor`).
- Geometries with an edge spanning more than 180° of longitude are refused with
  `422 ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN` (split them at the antimeridian, RFC 7946 §3.1.9).

### Fixed

- The explicit repair of the legacy Batam polygon unions its overlapping parts
  (`ST_MakeValid(geom, 'method=structure')`: 70 parts, 795 vertices, 7 358.689 km²) instead of
  cutting the overlaps out (`linework` method: 45 988 m² lost). `properties.geometryRepair`
  records the method and the part counts. Deployments seeded before: run `pnpm seed:update`.
- The seed summary log line has `msg: "Seed finished"` and `context: "Seed"` (the message was
  taken as the context).

## [0.1.0] - 2026-11-21

### Added

- Zones/geofences registry (spec §13.6): table `geo.zones` (`geography(Geometry,4326)`, every
  `ZoneSnapshotV1` kind, `UNIQUE NULLS NOT DISTINCT (org_id, code)`), global zones (`org_id`
  NULL) and organization zones.
- GeoJSON input validation: RFC 7946 structure and WGS84 bounds (`[lon, lat]` hint), geometry
  type allowed per kind, at most 50 000 vertices, point zones need a buffer, kind-specific
  `properties` (contracts `ZONE_PROPERTY_SCHEMAS`), PostGIS `ST_IsValidDetail` with reason and
  location (`422 ZONE_GEOMETRY_INVALID`); geometries are never repaired silently.
- Tenancy: global zones written by `super_admin` / `authority` only, organization zones within
  the active organization, reads of global + own zones (`authority` / `super_admin`: all); the
  owner always comes from the access token.
- Endpoints `GET /api/v2/zones` (kind, active, bbox, orgId, search, pages),
  `GET /api/v2/zones/:id`, `GET /api/v2/zones/geojson` (FeatureCollection for the map),
  `POST /api/v2/zones`, `PATCH /api/v2/zones/:id`, `DELETE /api/v2/zones/:id`,
  `POST /api/v2/zones/republish` (`super_admin`) and `GET /api/v2/zones/methodology`.
- Transactional outbox publishing `geo.zone.upserted.v1` / `geo.zone.deleted.v1` to the
  compacted `GEO` stream and the `audit.recorded.v1` records of every zone change to `AUDIT`:
  `Nats-Msg-Id` = outbox id, rows claimed with `FOR UPDATE SKIP LOCKED` (several replicas),
  per-zone order, retries with exponential backoff and jitter, failed rows kept, retention
  cleanup, `aisits_outbox_*` metrics.
- `zones_tiles` view (global active zones, geometry) for Martin, `SELECT` granted to `tiles_ro`
  when the role exists.
- `pnpm seed` / `pnpm seed:update`: the MVP pipeline (`data/legacy/pipeline.json`, LineString in
  legacy file order, KP markers, buffer 1 750 m) and the Batam transhipment area
  (`data/legacy/batam.json`, MultiPolygon, explicit and recorded `ST_MakeValid` repair), each
  with its source and provenance note; idempotent by code.
- Domain metrics `aisits_geo_zone_changes_total{kind,action}` and
  `aisits_geo_zone_rejections_total{code}`.
- Unit tests of the rules and mappings; integration tests against PostGIS and NATS containers.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-geo-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-geo-service/releases/tag/v0.1.0
