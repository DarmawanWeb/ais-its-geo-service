import 'reflect-metadata';

import { loadConfig } from '@darmawanweb/ais-its-nest';
import { PlatformRootModule } from '@darmawanweb/ais-its-nest/http';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { GeoOutboxRelay } from './modules/outbox/geo-outbox.relay.js';
import { ZoneSeeder } from './modules/seed/zone-seeder.js';

// `pnpm seed [--update]`: the MVP zones (spec §13.6), idempotent by code.
// Runs the application without HTTP: migrations apply on init
// (DB_MIGRATE_ON_BOOT), the seeded snapshots go through the outbox and are
// published before exit when the relay is enabled; otherwise the running
// service's relay publishes them.
const config = loadConfig(configSchema);
const mode = process.argv.includes('--update') ? 'update' : 'insert-missing';

const app = await NestFactory.createApplicationContext(
  PlatformRootModule.wrap(AppModule, config),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- Nest declares its options as classes; plain objects are the documented usage
  { bufferLogs: true, abortOnError: false },
);
app.useLogger(app.get(Logger));
try {
  await app.init();
  const results = await app.get(ZoneSeeder).seed(mode);
  if (config.OUTBOX_RELAY_ENABLED) {
    const relay = app.get(GeoOutboxRelay);
    // One row per ordering key per pass: loop until nothing is left to claim.
    for (let pass = 0; pass < 20; pass += 1) {
      if ((await relay.relayOnce()).claimed === 0) break;
    }
  }
  app
    .get(Logger)
    .log({ mode, zones: results }, `Seed finished (${results.length} zones)`);
} finally {
  await app.close();
}
