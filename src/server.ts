import 'reflect-metadata';

import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

const config = loadConfig(configSchema);

// Connect, migrate and ensure streams (onModuleInit) → start the outbox relay
// (onApplicationBootstrap) → listen on HOST:PORT. SIGTERM turns readiness to
// 503, stops the relay, drains NATS, then closes the pool.
await bootstrapService({
  appModule: AppModule,
  config,
  openapi: OPENAPI,
  // GeoJSON of large zones is bigger than the kit's 1 MiB default.
  adapter: { bodyLimitBytes: config.HTTP_BODY_LIMIT_BYTES },
});
