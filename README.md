# ais-its-geo-service

The **zones and geofences registry** of AIS Maritime Intelligence v2: validated GeoJSON zones
(pipelines, transhipment areas, fishing grounds, protected and restricted areas, anchorages,
ports, TSS lanes, shallow water, custom geofences), the map layers of the web app and the `GEO`
snapshot stream that the safety and surveillance detectors project.

Service `geo` — NestJS 12 + Fastify on the platform kit
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest),
PostgreSQL schema `geo` (PostGIS), NATS JetStream, port **3009**, image
`ghcr.io/darmawanweb/ais-its-geo-service`. The normative engineering spec is
[`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) (§13.6) in the central repository
[`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform).

## Purpose and responsibilities

- **Registry** of zones with every kind of `ZoneSnapshotV1` (contracts): global zones
  (`org_id` NULL, shared by every tenant) and organization zones (tenant-private).
- **Input validation** of GeoJSON (RFC 7946, WGS84): structure and bounds, the geometry type
  allowed per kind, at most 50 000 vertices, PostGIS `ST_IsValid` with the GEOS reason and
  location. Invalid geometries are refused with a helpful error — never repaired silently.
- **Tenancy** (spec §8.5) from the access token only: global zones are written by
  `super_admin` / `authority`, organization zones within the active organization; reads return
  global zones plus the own organization's zones (`authority` and `super_admin`: every zone).
- **Queries** for the web: filtered, paged lists (kind, active, bbox, owner, search), one zone
  with its geometry, and a GeoJSON `FeatureCollection` for the map.
- **Publication** of every change as `geo.zone.upserted.v1` / `geo.zone.deleted.v1` to the
  compacted `GEO` stream (one message per zone) through a **transactional outbox**, plus
  `audit.recorded.v1` records of every change; `POST /zones/republish` replays all snapshots.
- **Vector tiles**: the `zones_tiles` view (global active zones, geometry) read by Martin as
  `tiles_ro`.
- **Seeds** (`pnpm seed`): the MVP pipeline and Batam transhipment area as global zones.

Not here: distance/containment analytics (safety and surveillance detectors use the Detector
SDK `ZoneIndex` on their `GEO` projection), alerts (notification), vessel data (fleet).

## Architecture

```mermaid
flowchart LR
  web["Web app<br/>(map, zone admin)"] -->|"REST /api/v2/zones<br/>Bearer JWT"| ctl
  subgraph geo["geo service :3009"]
    ctl["ZonesController<br/>DTO validation"] --> svc["ZonesService<br/>tenancy · rules · unit of work"]
    seeder["ZoneSeeder<br/>(pnpm seed)"] --> svc
    svc --> dom["domain/<br/>pure rules + snapshot mapping"]
    svc --> repo["ZonesRepository<br/>drizzle + PostGIS"]
    relay["GeoOutboxRelay<br/>FOR UPDATE SKIP LOCKED<br/>retries + metrics"]
  end
  repo -->|"zone row + outbox rows<br/>in one transaction"| pg[("PostgreSQL<br/>schema geo")]
  relay -->|"claim · mark published"| pg
  relay -->|"geo.zone.v1.&lt;zoneId&gt;<br/>Nats-Msg-Id = outbox id"| GEO[["JetStream GEO<br/>max_msgs_per_subject = 1"]]
  relay -->|"audit.v1.geo"| AUDIT[["JetStream AUDIT"]]
  GEO --> safety["safety<br/>durable safety-zones"]
  GEO --> surveillance["surveillance<br/>durable surveillance-zones"]
  AUDIT --> auth["auth<br/>durable auth-audit"]
  martin["Martin tiles<br/>role tiles_ro"] -->|"SELECT zones_tiles<br/>(global, active)"| pg
```

A write runs `controller → service → repository`: the DTO is validated by the kit's global
`ValidationPipe`, the service decides the owner from the principal, validates the geometry (pure
rules first, then PostGIS), and a `ZoneUnitOfWork` writes the zone row, its `geo.zone.*` event and
its audit record into `outbox` in **one transaction**. The relay publishes committed rows
afterwards (at least once; JetStream deduplicates retries by `Nats-Msg-Id` within 2 minutes).

Startup follows the kit's lifecycle: connect, migrate (`DB_MIGRATE_ON_BOOT`) and ensure the
produced streams `GEO` and `AUDIT` (`onModuleInit`) → start the outbox relay
(`onApplicationBootstrap`) → open the port. On `SIGTERM` readiness turns `503`, the relay
finishes its pass, NATS drains and the pool closes.

| Path                           | What                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/main.ts`, `src/server.ts` | tracing first, then `bootstrapService()`                           |
| `src/app.module.ts`            | database, NATS (`GEO`, `AUDIT` produced), auth, audit, features    |
| `src/config.ts`                | zod environment schema extending the kit's base schema             |
| `src/domain/`                  | pure zone rules, errors, snapshot/feature mapping (unit-tested)    |
| `src/modules/zones/`           | controller, service, repository + unit of work, DTOs, access rules |
| `src/modules/outbox/`          | `GeoOutboxRelay` and its retry policy                              |
| `src/modules/seed/`            | MVP datasets → seed zones (`pnpm seed`)                            |
| `src/modules/methodology/`     | `GET /api/v2/zones/methodology` (spec §17)                         |
| `src/db/schema.ts`             | drizzle definitions mirroring `migrations/*.sql`                   |
| `migrations/`                  | forward-only SQL migrations                                        |
| `data/legacy/`                 | byte-identical MVP datasets used by the seed                       |
| `test/`                        | integration tests (`*.int.test.ts`, testcontainers)                |

## Data model

Schema `geo`, owned by `geo_svc`; [`migrations/0001_init.sql`](migrations/0001_init.sql) is
forward-only and checksummed (never edit an applied file — add `0002_<change>.sql`).

**`zones`** — one row per zone (`ZoneSnapshotV1` is its published state).

| Column                     | Type                       | Rules                                                                                                        |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`                       | `uuid` PK                  | UUID v7 from the application                                                                                 |
| `org_id`                   | `uuid` NULL                | owner; `NULL` = global zone                                                                                  |
| `code`                     | `text`                     | slug `^[a-z0-9][a-z0-9._-]{0,63}$`, unique per owner (`UNIQUE NULLS NOT DISTINCT (org_id, code)`), immutable |
| `name`                     | `text`                     | 1–200 characters                                                                                             |
| `kind`                     | `text` + `CHECK`           | the ten kinds of `ZoneSnapshotV1`                                                                            |
| `geom`                     | `geography(Geometry,4326)` | 2-D WGS84; `CHECK (ST_IsValid(geom::geometry))` as last line of defence                                      |
| `buffer_m`                 | `double precision`         | 0–100 000 m                                                                                                  |
| `alert_on_enter`           | `boolean`                  | geofence alerts (surveillance `geofence` detector)                                                           |
| `active`                   | `boolean`                  | inactive zones are kept but ignored by detectors and tiles                                                   |
| `properties`               | `jsonb` object             | kind-specific (contracts `ZONE_PROPERTY_SCHEMAS`), ≤ 64 KiB                                                  |
| `source`                   | `text` NULL                | provenance of the geometry; published as `properties.source`                                                 |
| `created_by`               | `uuid` NULL                | creating user; `NULL` for seeds                                                                              |
| `created_at`, `updated_at` | `timestamptz`              | `updated_at` strictly increases per zone (snapshot ordering)                                                 |

Indexes: GiST on `(geom::geometry)` (bbox queries in lon/lat space), `(org_id, kind)`,
`(kind, active)`.

**`outbox`** — the transactional outbox: the kit's `outboxTableSql()` columns (`id` = envelope id =
`Nats-Msg-Id`, `type`, `entity_key`, `data`, `created_at`, `attempts`, `last_error`,
`published_at`, `failed_at`) plus `seq` (identity, insertion order), `ordering_key`
(generated: `geo:<zoneId>` for zone events, `audit:<target>` for audit records) and
`next_attempt_at` (retry backoff). Published rows are deleted after `OUTBOX_RETENTION_HOURS`;
failed rows are kept for inspection.

**`zones_tiles`** (view, `security_barrier`) — `id, code, name, kind, buffer_m, alert_on_enter,
updated_at, geom geometry(Geometry,4326)` of **global active zones only**, because Martin cannot
apply tenancy. `GRANT USAGE ON SCHEMA` and `GRANT SELECT ON zones_tiles` to `tiles_ro` when that
role exists (spec §6). Organization zones reach the map only through the authenticated
`GET /api/v2/zones/geojson`.

### Zone kinds and geometry rules

| Kind                | Allowed geometry types                                   | Used by (consumers)                   |
| ------------------- | -------------------------------------------------------- | ------------------------------------- |
| `pipeline`          | LineString, MultiLineString                              | safety `ews` (distance to the line)   |
| `transhipment_area` | Polygon, MultiPolygon                                    | surveillance `transhipment`           |
| `fishing_ground`    | Polygon, MultiPolygon                                    | surveillance `fishing`                |
| `mpa`               | Polygon, MultiPolygon                                    | surveillance `geofence`               |
| `shallow_water`     | Polygon, MultiPolygon                                    | future grounding detector             |
| `restricted`        | Polygon, MultiPolygon, Point, MultiPoint (`bufferM > 0`) | surveillance `geofence`, `fishing`    |
| `anchorage`, `port` | Polygon, MultiPolygon, Point, MultiPoint (`bufferM > 0`) | surveillance `dark` (exclusion areas) |
| `tss_lane`          | Polygon, MultiPolygon, LineString, MultiLineString       | future TSS detector                   |
| `custom`            | any, including GeometryCollection                        | surveillance `geofence`               |

Validation runs cheapest first and stops at the first failing step (on `PATCH`, a new geometry's
structure, vertex count and validity are checked before the row is locked, then the kind rules
and properties against the resulting zone):

| Step | Rule                                                                                            | Problem                                                                          |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | DTO: code slug, name, kind, `bufferM` 0–100 000, booleans, `null` only for `source`             | `400 VALIDATION_FAILED`                                                          |
| 2    | GeoJSON structure (closed rings, non-empty parts), lon −180…180 / lat −90…90; altitudes dropped | `400 VALIDATION_FAILED` (`geometry.*` field paths, `[longitude, latitude]` hint) |
| 3    | geometry type allowed for the kind                                                              | `422 ZONE_GEOMETRY_TYPE_NOT_ALLOWED`                                             |
| 4    | at most 50 000 vertices (contracts `ZONE_MAX_VERTICES`)                                         | `422 ZONE_GEOMETRY_TOO_COMPLEX`                                                  |
| 5    | point zones need `bufferM > 0`                                                                  | `422 ZONE_BUFFER_REQUIRED`                                                       |
| 6    | `properties` match the kind's schema (`properties.source` is reserved), ≤ 64 KiB                | `400 VALIDATION_FAILED` (`properties.*`)                                         |
| 7    | PostGIS `ST_IsValidDetail` — reason and `[lon, lat]` location in `detail`; no `ST_MakeValid`    | `422 ZONE_GEOMETRY_INVALID`                                                      |
| 8    | code unique for the owner                                                                       | `409 ZONE_CODE_TAKEN`                                                            |

Other problem codes: `404 ZONE_NOT_FOUND` (unknown or not visible), `403 GLOBAL_ZONE_WRITE_FORBIDDEN`,
`403 ZONE_WRITE_FORBIDDEN` (visible zone of another organization), `403 ORGANIZATION_REQUIRED`
(organization zone without an active organization), `403 PLATFORM_ADMIN_REQUIRED` (republish),
`403 FORBIDDEN` (owner filter on another organization), `401 UNAUTHORIZED`. All errors are
RFC 9457 problem details (`application/problem+json`).

## API

Routes live under `/api/v2` (Swagger UI `/docs`, JSON `/openapi.json`, committed as
[`openapi.json`](openapi.json)); the gateway routes `/api/v2/zones` to this service (spec §12).

| Method | Path                            | Permission                          | What                                                                                                                                                                                               |
| ------ | ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v2/zones`                 | `zone:read`                         | page of zone summaries without geometry; `kind` (repeated or comma list), `active`, `bbox=minLon,minLat,maxLon,maxLat`, `orgId`, `search`, `page`, `pageSize`                                      |
| GET    | `/api/v2/zones/geojson`         | `zone:read`                         | `FeatureCollection` (`application/geo+json`) of visible zones for the map; `kind`, `bbox`, `orgId`, `active` (default `true`); 6 decimals; `truncated`/`limit` beyond `ZONES_GEOJSON_MAX_FEATURES` |
| GET    | `/api/v2/zones/:id`             | `zone:read`                         | one zone with its geometry                                                                                                                                                                         |
| POST   | `/api/v2/zones`                 | `zone:write`                        | create; `global: true` = global zone (`super_admin` / `authority`), else the active organization owns it → `201`                                                                                   |
| PATCH  | `/api/v2/zones/:id`             | `zone:write`                        | change name, kind, geometry, buffer, flags, properties (replaced), source (`null` clears); re-validated; no-op changes publish nothing                                                             |
| DELETE | `/api/v2/zones/:id`             | `zone:write`                        | delete and publish the tombstone → `204`                                                                                                                                                           |
| POST   | `/api/v2/zones/republish`       | `zone:write` + `super_admin`        | enqueue the snapshot of every zone → `202 { enqueued }`                                                                                                                                            |
| GET    | `/api/v2/zones/methodology`     | any signed-in user                  | methods implemented here with their sources (spec §17)                                                                                                                                             |
| GET    | `/health/live`, `/health/ready` | public                              | liveness; readiness (database, NATS)                                                                                                                                                               |
| GET    | `/metrics`                      | public (not exposed by the gateway) | Prometheus metrics                                                                                                                                                                                 |

Visibility: org users see global zones and their organization's zones (another organization's zone
answers `404`); `authority` and `super_admin` see every zone. Writes: organization zones by
`zone:write` holders of the owning organization (and `super_admin`); global zones by `super_admin`
and `authority`. The owner always comes from the token — an `orgId` in the body is refused.

```bash
TOKEN=…   # access token from auth (POST /api/v2/auth/login)
curl -s -X POST localhost:3009/api/v2/zones -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"btm-anchorage-a","name":"Batam anchorage A","kind":"anchorage","bufferM":500,
       "geometry":{"type":"Point","coordinates":[104.02,1.17]},"properties":{"unlocode":"IDBTM"}}'
curl -s "localhost:3009/api/v2/zones/geojson?kind=pipeline,anchorage&bbox=103,0.5,113,2" -H "Authorization: Bearer $TOKEN"
```

## Events

This service is the **producer** of the `GEO` stream (it ensures `GEO` and `AUDIT` at boot) and
consumes no stream.

| Direction | Stream  | Subject                | Type                   | Payload                                                                                                               | Consumers                            |
| --------- | ------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| publishes | `GEO`   | `geo.zone.v1.<zoneId>` | `geo.zone.upserted.v1` | `ZoneSnapshotV1` (`source` → `properties.source`)                                                                     | `safety-zones`, `surveillance-zones` |
| publishes | `GEO`   | `geo.zone.v1.<zoneId>` | `geo.zone.deleted.v1`  | `ZoneDeletedV1` `{ id, orgId }` (tombstone)                                                                           | `safety-zones`, `surveillance-zones` |
| publishes | `AUDIT` | `audit.v1.geo`         | `audit.recorded.v1`    | `zone.create`, `zone.update` (`meta.fields`), `zone.delete`, `zone.republish`; seeds as system actor with `meta.seed` | `auth-audit`                         |

- `GEO` keeps one message per subject (`max_msgs_per_subject = 1`): the last snapshot or the
  tombstone of each zone, so a new consumer rebuilds the full registry from the stream.
- Envelope `id` = outbox row id = `Nats-Msg-Id`; `subject` = zone id; `time` = commit time of the
  change; `source` = `geo`.
- Per-zone order is preserved: rows of one `ordering_key` are published one after the other in
  `seq` order, across replicas; `updated_at` strictly increases so consumers can drop stale
  snapshots.

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values and prints every problem (spec §4).

| Variable                        | Default (dev)                                      | Notes                                                               |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`                      | `development`                                      | `development` \| `test` \| `production`                             |
| `SERVICE_NAME`                  | `geo`                                              | logs, metrics, event `source`, `audit.v1.geo`                       |
| `SERVICE_VERSION`               | `package.json` version                             | logs, OpenAPI, telemetry                                            |
| `HOST` / `PORT`                 | `0.0.0.0` / `3009`                                 | spec §3                                                             |
| `LOG_LEVEL`                     | `info`                                             | pino level                                                          |
| `LOG_PRETTY`                    | `true` in development                              | needs the dev dependency `pino-pretty`                              |
| `SHUTDOWN_TIMEOUT_MS`           | `30000`                                            | graceful shutdown deadline                                          |
| `DATABASE_URL`                  | `postgres://geo_svc:geo_svc@localhost:5432/aisits` | required in production                                              |
| `DATABASE_SCHEMA`               | `geo`                                              | `search_path=geo,public`                                            |
| `DATABASE_POOL_MAX`             | `10`                                               |                                                                     |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000`                                            | per statement                                                       |
| `DB_MIGRATE_ON_BOOT`            | `true`                                             | also `pnpm migrate`                                                 |
| `NATS_URL`                      | `nats://localhost:4222`                            | comma separated list allowed                                        |
| `NATS_DURABLE_PREFIX`           | unset                                              | prefix of durable names (no durable consumer here)                  |
| `REDIS_URL`                     | `redis://localhost:6379`                           | common schema only — the service does not use Valkey                |
| `AUTH_JWKS_URL`                 | `http://localhost:3001/.well-known/jwks.json`      | access tokens are verified locally (cached JWKS)                    |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | `ais-its-auth` / `ais-its-api`                     |                                                                     |
| `AUTH_INTERNAL_URL`             | `http://localhost:3001`                            | API-key introspection (no route accepts API keys here)              |
| `INTERNAL_TOKEN`                | `dev-internal-token-change-me`                     | ≥ 16 characters and changed in production                           |
| `CORS_ORIGINS`                  | `http://localhost:5173,http://localhost:8000`      |                                                                     |
| `PUBLIC_BASE_URL`               | `http://localhost:8000`                            |                                                                     |
| `TRUSTED_PROXIES`               | `loopback,linklocal,uniquelocal`                   | proxies whose `X-Forwarded-For` is trusted (audit IPs)              |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | unset                                              | OTLP/HTTP tracing when set                                          |
| `HTTP_BODY_LIMIT_BYTES`         | `4194304` (4 MiB)                                  | a 50 000-vertex zone is ~1.5 MB of GeoJSON                          |
| `ZONES_GEOJSON_MAX_FEATURES`    | `5000`                                             | features per `/zones/geojson` response (more → `truncated: true`)   |
| `OUTBOX_RELAY_ENABLED`          | `true`                                             | run the relay loop in this process                                  |
| `OUTBOX_POLL_INTERVAL_MS`       | `500`                                              | idle polling; a committed change wakes the relay at once            |
| `OUTBOX_BATCH_SIZE`             | `100`                                              | rows claimed per relay transaction                                  |
| `OUTBOX_RETRY_BASE_MS`          | `1000`                                             | first retry delay after a failed publication (doubles, with jitter) |
| `OUTBOX_RETRY_MAX_MS`           | `60000`                                            | largest retry delay                                                 |
| `OUTBOX_RETENTION_HOURS`        | `24`                                               | published rows are deleted afterwards                               |

## Local development

Requirements: Node.js 24 (`.nvmrc`; ≥ 22.12 works), pnpm 10 (`corepack enable`), Docker.
`@darmawanweb/*` packages come from GitHub Packages: map the scope once in `~/.npmrc` (never in
this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir ../.. infra:up        # central repo: postgres (+PostGIS), nats, … (or any reachable instances)
pnpm dev                         # watch mode (SWC, decorator metadata), migrations on boot
pnpm seed                        # MVP pipeline + Batam zones (idempotent by code)
curl -s localhost:3009/health/ready
open http://localhost:3009/docs  # Swagger UI
```

| Script                                          | What                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                                      | watch mode (`nest start --watch --builder swc`)                                       |
| `pnpm build` / `pnpm start` / `pnpm start:prod` | compile with `tsc` to `dist/` / run it / run with `NODE_ENV=production`               |
| `pnpm migrate`                                  | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`)                     |
| `pnpm seed` / `pnpm seed:update`                | seed missing MVP zones / also overwrite changed dataset fields of existing seed zones |
| `pnpm openapi` / `pnpm openapi:check`           | write `openapi.json` without any infrastructure / fail when it is stale (CI)          |
| `pnpm test` / `pnpm test:int` / `pnpm test:all` | unit tests / integration tests (Docker) / both                                        |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`  | ESLint, `tsc --noEmit`, Prettier                                                      |

From the image: `docker run --rm --env-file .env ghcr.io/darmawanweb/ais-its-geo-service node dist/seed.js`.

## Testing

- **Unit** (`pnpm test`, `src/**/*.spec.ts`, no Docker): geometry rules (structure, WGS84 bounds,
  `[lon, lat]` hint, type per kind, vertex limit, point buffers, 2-D reduction), property
  schemas, snapshot/tombstone/feature mapping, access rules (read scopes, owners, writability),
  the service's use cases with fakes (outbox rows of each change, 409/422 mapping, no-op updates,
  kind changes re-validating the stored geometry, republish for `super_admin` only, the feature
  cap, idempotent seeds), DTOs (null handling, whitelist), the relay retry policy, the legacy
  dataset mapping (61 KP markers in file order, duplicates kept; 73 parts / 795 vertices) and the
  methodology catalog lookup.
- **Integration** (`pnpm test:int`, `test/*.int.test.ts`): the real `AppModule` against
  `timescale/timescaledb-ha:pg17` (PostGIS) and `nats:2.11-alpine` started once by
  `test/support/global-setup.ts`, with access tokens from the kit's test issuer:
  CRUD and validation errors (400/409/422 with reasons), tenancy (global vs organization zones;
  `authority`/`super_admin` vs org users; body `orgId` refused), bbox/kind/active/search queries
  and the `FeatureCollection`, the outbox relay (snapshots and tombstones read back from `GEO`,
  `Nats-Msg-Id`, retries with backoff, failed rows, several relays without duplicates or
  reordering, retention), republish (`super_admin` only), seeds (geometry, markers, repair record,
  idempotency, update mode), and the `zones_tiles` grant with and without `tiles_ro`.
- `TESTCONTAINERS_RYUK_DISABLED=true` is set by the config; the global teardown stops the containers.

## Operations

- **Health**: `GET /health/live` (process), `GET /health/ready` (database and NATS; `503` while
  shutting down). Docker `HEALTHCHECK` on `/health/live`.
- **Metrics** (`GET /metrics`, prefix `aisits_`):

  | Metric                                                               | Labels                           | Meaning                                                                   |
  | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
  | `aisits_http_requests_total`, `aisits_http_request_duration_seconds` | `method`, `route`, `status_code` | HTTP RED metrics (kit)                                                    |
  | `aisits_events_published_total`                                      | `type`, `outcome`                | publications `stored`, `duplicate` (deduplicated retry) or `failed` (kit) |
  | `aisits_geo_zone_changes_total`                                      | `kind`, `action`                 | committed creates, updates, deletes, republished zones                    |
  | `aisits_geo_zone_rejections_total`                                   | `code`                           | writes refused by the input rules, by problem code                        |
  | `aisits_outbox_relayed_total`                                        | `type`, `outcome`                | rows `published`, `failed` (retried) or `rejected`                        |
  | `aisits_outbox_pending`                                              |                                  | rows waiting to be published                                              |
  | `aisits_outbox_oldest_pending_seconds`                               |                                  | age of the oldest waiting row (alert when it grows)                       |
  | `aisits_outbox_failed_rows`                                          |                                  | rows that can never be published (kept for inspection)                    |
  | `aisits_outbox_relay_pass_duration_seconds`                          |                                  | duration of one relay pass                                                |

- **Logs**: pino JSON with `service`, `version`, `requestId`, `traceId`; relay failures carry
  `outboxId`, `eventType`, `attempts`, `retryInMs`, `error`.
- **Troubleshooting**:
  - _Outbox backlog grows_ (`aisits_outbox_pending`, `aisits_outbox_oldest_pending_seconds`):
    NATS unreachable or the stream missing — check `/health/ready` and the warnings
    "Publishing an outbox row failed"; inspect
    `SELECT id, type, attempts, last_error, next_attempt_at FROM geo.outbox WHERE published_at IS NULL ORDER BY seq LIMIT 20;`.
    Rows retry with exponential backoff (`OUTBOX_RETRY_*`); a zone's later rows wait behind its
    head row, other zones keep flowing.
  - _Failed rows_ (`aisits_outbox_failed_rows > 0`): the payload no longer matches the contract or
    exceeds the NATS `max_payload` (4 MB on the platform server); read `last_error`, fix the
    cause, then `POST /api/v2/zones/republish` and delete the failed rows.
  - _A consumer misses zones_ or the `GEO` stream was recreated: `POST /api/v2/zones/republish`
    (`super_admin`) enqueues the current snapshot of every zone.
  - _Martin shows no zones_: `tiles_ro` did not exist when the migration ran — as `geo_svc`:
    `GRANT USAGE ON SCHEMA geo TO tiles_ro; GRANT SELECT ON geo.zones_tiles TO tiles_ro;`.
    Organization zones and inactive zones are never in the tiles (by design).
  - _`422 ZONE_GEOMETRY_INVALID`_: the `detail` names the GEOS reason and location; repair the
    geometry in QGIS ("Fix geometries") or with `ST_MakeValid` and submit it again.
  - _`413`_: raise `HTTP_BODY_LIMIT_BYTES`; _`truncated: true`_: narrow `bbox`/`kind` or raise
    `ZONES_GEOJSON_MAX_FEATURES`.
- **Image**: `ghcr.io/darmawanweb/ais-its-geo-service` (CI pushes `main` and `sha-<commit>`,
  releases push `<version>`, `<major>.<minor>`, `latest`); `node:24-alpine`, non-root `node`,
  production dependencies only, `migrations/` and `data/` included. Local build:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-geo-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-geo-service .
  ```

- **Release**: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new
  version, bump `package.json`, tag `v<version>`.

## Seeds and dataset provenance

`pnpm seed` creates the global MVP zones, **idempotent by code**: an existing zone is kept as it is
(operator changes survive); `pnpm seed:update` overwrites changed dataset fields. Every seed write
goes through the same validation, outbox and audit trail as the API (system actor). The files in
[`data/legacy/`](data/legacy) are byte-identical copies of the MVP backend's `data/*.json`; the
SHA-256 of each file is stored in `properties.dataset`.

| Code                     | Kind                | Geometry                                                                                                            | Source file (SHA-256)                             |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `mvp-pipeline`           | `pipeline`          | LineString of the 61 KP points in file order, `bufferM` 1 750, KP names as `properties.markers[{ name, lat, lon }]` | `data/legacy/pipeline.json` (`56f6578f…c767e26b`) |
| `mvp-batam-transhipment` | `transhipment_area` | MultiPolygon (73 parts, 795 vertices in the file; 807 after the explicit repair, see below)                         | `data/legacy/batam.json` (`524406c9…20cd9763`)    |

Both carry `source` and `properties.note = "MVP dataset, origin to be cited from the thesis"`.

**Provenance gaps** (see [`data.pipeline_route`](../../docs/METHODOLOGY.md#data.pipeline_route) and
[`data.batam_area`](../../docs/METHODOLOGY.md#data.batam_area); both `needsCitation`):

- _Pipeline_: a KP list of a subsea pipeline off Gresik (western approach to Surabaya). Origin,
  datum (WGS84 assumed) and design/as-laid status are unknown; two different points are labelled
  "KP 42.200"; the file is not in KP order (48.6 km in file order vs 33.6 km in KP order). It needs
  a citation from the thesis and permission to publish coordinates of critical infrastructure.
- _Batam_: the land polygon of Kepulauan Riau province (KODE_PROV 21), most likely a mapshaper
  export of a Kemendagri boundary dataset of unknown licence — **not** an authoritative
  transhipment, STS or anchorage area. The legacy code never read it. Its parts overlap, so
  `ST_IsValid` fails (self-intersection): the seed — and only the seed — repairs it with
  `ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))`, logs a warning and records the method,
  GEOS reason (`Self-intersection` near 104.078° E, 0.945° N), location and vertex counts
  (795 → 807) in `properties.geometryRepair`. The area should be
  replaced by one defined by the thesis or the port authority (`PATCH` the zone or a new dataset).

## Legacy parity

- **Pipeline geometry**: the legacy EWS (`be-legacy/src/utils/calculate-ews.ts:checkShipStatus`)
  builds a LineString from `data/pipeline.json` **in file order** and measures with turf
  `nearestPointOnLine`; the seed keeps exactly that vertex order (not sorted by KP), so the safety
  service's distances match the legacy ones. The legacy code re-read the file on every call; v2
  publishes the zone once to `GEO` and safety projects it.
- **Buffers**: the legacy frontend drew 500 m / 1 750 m pipeline buffers
  (`ews.fe_buffer_polygons`) from its own `pipe.json` (first 31 points, sorted by KP); v2 maps
  pipelines from `GET /zones/geojson` and the zone's `bufferM` (1 750 m). The EWS thresholds
  themselves stay in the safety service (`EWS_DANGER_M`, `EWS_WARNING_M`).
- **Batam area**: unused by the legacy backend (transhipment relied on the Batam AIS feed flag);
  seeded as the `transhipment_area` of spec §13.6 for the surveillance detector.
- Zone CRUD, tenancy, validation, tiles and the `GEO` stream are new in v2 (no legacy counterpart).

## Methodology & references

Every formula, constant, threshold and rule is traceable to its source (spec §17): implementing
functions carry `@method <id>` TSDoc, the ids are listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/zones/methodology` from the contracts catalog `./references`) and
described in [`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) /
`docs/references/methods.json`.

| Method id                                                              | Implemented by                                                                                                                                                                                         | Sources                                                                                                                                                                                                                                                      | Status                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| [`data.pipeline_route`](../../docs/METHODOLOGY.md#data.pipeline_route) | `src/modules/seed/legacy-datasets.ts#pipelineSeedZone`, `PIPELINE_CORRIDOR_BUFFER_M` (1 750 m = d_warning of [`ews.pipeline_distance_status`](../../docs/METHODOLOGY.md#ews.pipeline_distance_status)) | legacy `be-legacy/data/pipeline.json`, `calculate-ews.ts`; [PP 27/2021](https://peraturan.bpk.go.id/Details/161858/pp-no-27-tahun-2021); [Ditjen Migas 1 750 m](https://migas.esdm.go.id/post/tumpahan-minyak-pipa-penyalur-minyak-pertamina-sesuai-standar) | needs citation (thesis) |
| [`data.batam_area`](../../docs/METHODOLOGY.md#data.batam_area)         | `src/modules/seed/legacy-datasets.ts#batamSeedZone`                                                                                                                                                    | legacy `be-legacy/data/batam.json`; [mapshaper](https://github.com/mbloch/mapshaper); [Kemendagri region codes](https://github.com/cahyadsn/wilayah); [Natural Earth admin-1](https://github.com/nvkelso/natural-earth-vector) (ruled out as origin)         | needs citation (thesis) |

Related methods implemented by the consumers of this registry:
[`ews.pipeline_distance_status`](../../docs/METHODOLOGY.md#ews.pipeline_distance_status) (safety,
`pipeline` zones) and [`geo.geofence_enter`](../../docs/METHODOLOGY.md#geo.geofence_enter)
(surveillance, `alertOnEnter`).

The geometry input rules (type per kind, ≤ 50 000 vertices, WGS84 bounds, OGC validity) are
platform validation rules without a catalog id yet (proposed: `geo.zone_geometry_rules`); their
sources are [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946) (GeoJSON, WGS84 `[lon, lat]`),
[OGC Simple Features](https://www.ogc.org/standard/sfa/) validity as checked by
[PostGIS `ST_IsValidDetail`](https://postgis.net/docs/ST_IsValidDetail.html), and spec §13.6.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
