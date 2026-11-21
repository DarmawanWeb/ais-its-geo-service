import {
  type AppConfig,
  defineConfig,
  envBoolean,
  envInteger,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import { SERVICE } from './service.js';

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables. Add a variable here and to
 * `.env.example`; `loadConfig()` refuses to start on invalid values and prints
 * every problem.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),

  /**
   * Largest request body, bytes (default 4 MiB). A zone of 50 000 vertices
   * is about 1.5 MB of GeoJSON (more when pretty-printed by GIS tools), over
   * the kit's 1 MiB default.
   */
  HTTP_BODY_LIMIT_BYTES: envInteger(64 * 1024, 64 * 1024 * 1024).default(
    4 * 1024 * 1024,
  ),
  /** Most features of one `GET /zones/geojson` response (more → `truncated: true`). */
  ZONES_GEOJSON_MAX_FEATURES: envInteger(1, 50_000).default(5_000),

  /** Run the outbox relay loop in this process (tests and seed jobs turn it off). */
  OUTBOX_RELAY_ENABLED: envBoolean().default(true),
  /** Idle polling interval of the relay, ms (a committed change also wakes it). */
  OUTBOX_POLL_INTERVAL_MS: envInteger(10, 60_000).default(500),
  /** Rows claimed (FOR UPDATE SKIP LOCKED) per relay transaction. */
  OUTBOX_BATCH_SIZE: envInteger(1, 1_000).default(100),
  /** First retry delay after a failed publication, ms (doubles per attempt). */
  OUTBOX_RETRY_BASE_MS: envInteger(10, 600_000).default(1_000),
  /** Largest retry delay, ms. */
  OUTBOX_RETRY_MAX_MS: envInteger(10, 3_600_000).default(60_000),
  /** Published rows are deleted after this many hours (failed rows are kept). */
  OUTBOX_RETENTION_HOURS: envInteger(1, 24 * 90).default(24),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;
