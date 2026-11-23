import 'reflect-metadata';

import { loadConfig } from '@darmawanweb/ais-its-nest';
import { PlatformRootModule } from '@darmawanweb/ais-its-nest/http';
import { OutboxRelay } from '@darmawanweb/ais-its-nest/nats';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { ZoneSeeder } from './modules/seed/zone-seeder.js';

// `pnpm seed [--update]`: the MVP zones (spec §13.6), idempotent by code.
// Runs the application without HTTP: migrations apply on init
// (DB_MIGRATE_ON_BOOT), the seeded snapshots go through the outbox and are
// published before exit when the relay is enabled (rows a running service's
// relay holds are published by it); otherwise the service's relay publishes
// them.
const config = loadConfig(configSchema);
const mode = process.argv.includes('--update') ? 'update' : 'insert-missing';

const app = await NestFactory.createApplicationContext(
  PlatformRootModule.wrap(AppModule, config),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- Nest declares its options as classes; plain objects are the documented usage
  { bufferLogs: true, abortOnError: false },
);
app.useLogger(app.get(PinoLogger));
// A context logger: nestjs-pino reads the last string argument as the
// context, so the message goes before it (msg = "Seed finished").
const logger = new Logger('Seed');
try {
  await app.init();
  const results = await app.get(ZoneSeeder).seed(mode);
  if (config.OUTBOX_RELAY_ENABLED) {
    const relay = app.get(OutboxRelay);
    // A pass publishes up to OUTBOX_BATCH_SIZE rows (every row of a zone in
    // order); loop while passes make progress. Rows another relay holds are
    // skipped here and published by it (this process's loop finishes its pass
    // on close).
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await relay.relayOnce();
      if (result.published + result.rejected + result.deferred === 0) break;
    }
  }
  logger.log(
    { mode, zoneCount: results.length, zones: results },
    'Seed finished',
  );
} finally {
  await app.close();
}
