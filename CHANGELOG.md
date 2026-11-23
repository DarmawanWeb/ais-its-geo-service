# Changelog

All notable changes to `ais-its-geo-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-22

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0: the
local workarounds the kit now covers are gone (own outbox relay, size measuring, validation and
database helpers, in-service admin check), plus the backend gaps the web app reported and the
hardening of the review of 0.1.0.

### Added

- `POST /api/v2/zones/validate` (`zone:write`): a dry run of the input rules of a create
  (README steps 2–8: GeoJSON structure and WGS84 bounds, geometry type per kind, vertex limit,
  buffer of point zones, antimeridian, properties, PostGIS `ST_IsValidDetail`) for a draft
  `{ kind, geometry, bufferM?, properties? }`. It answers `200` with `valid`, `problem`,
  `geometryType`, `vertexCount` and `bbox`; `problem` is the problem details `POST /zones` would
  answer (e.g. `ZONE_GEOMETRY_INVALID` with the reason and the `[lon, lat]` location of a
  self-intersection); nothing is stored or published. A malformed body answers `400`.
- `global=true|false` filter on `GET /api/v2/zones` and `GET /api/v2/zones/geojson`: global
  zones only, or organization zones only within the read scope; `global=true` with `orgId` is
  `400 VALIDATION_FAILED` (`code: 'globalWithOrgId'`).
- `etag` on every zone body (`ZoneSummaryDto`, so list rows, and `ZoneDto`): the value of the
  `ETag` header, to send in `If-Match`.
- Migration `0003_outbox_kit_relay.sql`: the indexes of the kit's per-key relay
  (`outbox_pending_key_idx` on `(entity_key, seq)`, `outbox_pending_idx`, `outbox_retry_idx`,
  `outbox_failed_idx`); `ordering_key` is deprecated.
- Methodology: `@method` tags and `IMPLEMENTED_METHOD_IDS` for `geo.zone_geometry_rules`
  (`assertZoneGeometryRules`), `geo.zone_buffer_extent` (`bufferedBBoxCondition`) and
  `geo.map_simplification` (`simplificationToleranceDeg`), catalogued in contracts 0.4.0.
- Integration tests: a zone at the vertex limit (about 1.5 MB) through the 4MB test NATS and
  back from `GEO`; the same zone refused with `422` before anything is written by a service on a
  1MB NATS; the stored zone republished to the 1MB NATS parked and counted as `rejected`, and
  its recovery, with the README's metrics table and _Parked rows_ entry checked against
  `/metrics`; the kit relay on geo's table, including the `OUTBOX_BATCH_SIZE` claim limit; the
  dry run; the `global` filter; `etag`; OpenAPI headers, `format: uuid` and `x-required-roles`;
  CORS exposure of `ETag`.
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

- Dependencies: `@darmawanweb/ais-its-contracts` `^0.4.0`, `@darmawanweb/ais-its-nest` `^0.3.0`;
  `.pnpmfile.cjs` also strips the optional gRPC peers of `@nestjs/terminus` from the production
  install (template hook).
- The transactional outbox is relayed by the kit's `OutboxModule` in per-key mode (set
  explicitly, options from `OUTBOX_*`): every replica relays; a pass claims up to
  `OUTBOX_BATCH_SIZE` due rows (`FOR UPDATE SKIP LOCKED`) and publishes each zone's run of
  consecutive rows in `seq` order (a zone's snapshots, tombstone and audit records share its
  `entity_key`), up to 64 zones at once, so a zone with more due rows than the batch is
  published over several passes; a failed row backs off on its own and only its zone waits;
  rows that can never be published are parked (`failed_at`). `attempts` counts failed attempts
  only; `last_error` is sanitized. New gauge `aisits_outbox_retrying_rows`.
- Zone snapshots are measured by the kit: `enqueueEvent(…, { maxBytes })` with
  `NatsClient.maxPayloadBytes()` throws `EventTooLargeError` before the insert, mapped to
  `422 ZONE_SNAPSHOT_TOO_LARGE`; `snapshotBytes` is now the message size (encoded envelope plus
  the 1 KiB header allowance) and `maxBytes` the server's `max_payload` (was: envelope bytes
  against `max_payload` − 1 KiB).
- Audit records are written with `AuditService.enqueue(client, …)` in the transaction of the
  change (the kit normalizes the client ip).
- `POST /api/v2/zones/republish` is guarded by `@RequirePlatformAdmin()`: everyone but
  `super_admin` gets `403 PLATFORM_ADMIN_REQUIRED` (users without `zone:write` got
  `403 FORBIDDEN` before); OpenAPI shows `x-required-roles: ['super_admin']`. A bodiless JSON
  `POST` is accepted.
- Path parameter `id` is read with the kit's `@UuidParam()`: a malformed id answers
  `400 VALIDATION_FAILED` with `{ field: 'id', code: 'isUuid' }`; OpenAPI documents
  `format: uuid`.
- CORS exposes `ETag` and `Location` to `CORS_ORIGINS` (kit default).
- Migrations are resolved from the package (`MIGRATIONS_DIR`) by the service, `pnpm migrate`
  and `pnpm seed`, whatever the working directory.
- The kit warns at connect when the NATS `max_payload` is below 4 MiB and, in production, while
  `TRUSTED_PROXIES` is the default (`.env.example` documents the gateway-only setting); tracing
  exports traces only; database errors are sanitized in logs and problem details.
- `openapi.json` regenerated: the new endpoint and fields, the `global` parameter, the page
  maximum of 1 000 000, `format: uuid` path parameters, `x-required-roles`, declared security
  schemes.
- bbox filters of `GET /zones` and `GET /zones/geojson` match a zone when its buffer reaches the
  box (a point zone is a circle of `bufferM`, a pipeline a corridor), not only its raw geometry.
- `aisits_geo_zone_rejections_total{code}` counts every refused write (400/409/412/422) of
  `POST`/`PATCH`/`DELETE`, the DTO validation of the global `ValidationPipe` included
  (`ZoneRejectionsInterceptor`).
- Geometries with an edge spanning more than 180° of longitude are refused with
  `422 ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN` (split them at the antimeridian, RFC 7946 §3.1.9).

### Removed

- The `LOCAL WORKAROUND` `GeoOutboxRelay` (`src/modules/outbox/geo-outbox.relay.ts`) and its
  retry policy `outbox-policy.ts`; the metric `aisits_outbox_relay_pass_duration_seconds` (the
  kit relay has no pass histogram).
- `src/common/validation.ts` (`IsOptionalNotNull` is the kit's), `src/db/errors.ts`
  (`isUniqueViolation` is the kit's), `PlatformAdminRequiredError`, and the local snapshot
  measuring (`encodedSnapshotBytes`, `maxEnvelopeBytes`, `assertPublishable`,
  `EVENT_HEADER_ALLOWANCE_BYTES`).
- The direct `prom-client` dependency (metric types come from `@darmawanweb/ais-its-nest/metrics`).

### Fixed

- The explicit repair of the legacy Batam polygon unions its overlapping parts
  (`ST_MakeValid(geom, 'method=structure')`: 70 parts, 795 vertices, 7 358.689 km²) instead of
  cutting the overlaps out (`linework` method: 45 988 m² lost). `properties.geometryRepair`
  records the method and the part counts. Deployments seeded before: run `pnpm seed:update`.
- The seed summary log line has `msg: "Seed finished"` and `context: "Seed"` (the message was
  taken as the context).

### Not done

- `orgName` in zone summaries and GeoJSON feature properties (web app request): geo has no
  source of organization names (auth owns them, the token carries only the id, no organization
  event or internal lookup exists); auth should offer a name directory to `authority` and
  `super_admin`. See README, "Web app requests".

### Upgrade

- Migration `0003` runs at boot (indexes only). A 0.1 replica keeps relaying during a rolling
  update (both relays skip rows behind a locked older row of the same zone); rollback to 0.1
  works.
- Set `max_payload: 4MB` on Helm/external NATS servers and `TRUSTED_PROXIES` to the gateway
  CIDR in production; regenerate the web clients from `openapi.json`.

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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-geo-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-geo-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-geo-service/releases/tag/v0.1.0
