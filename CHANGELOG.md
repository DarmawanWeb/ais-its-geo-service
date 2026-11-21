# Changelog

All notable changes to `ais-its-geo-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
