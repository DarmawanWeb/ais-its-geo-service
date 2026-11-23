import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import {
  OutboxModule,
  type OutboxModuleOptions,
} from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import type { Config } from '../../config.js';
import { PublicationLimits } from './publication-limits.js';

/**
 * Options of the kit's outbox relay from the `OUTBOX_*` variables. The mode
 * is `per-key` explicitly: `geo.outbox` has `seq` and `next_attempt_at`
 * (`0001_init.sql`), and a table without them must fail the start rather
 * than fall back to the serial relay. Every replica relays (`FOR UPDATE SKIP
 * LOCKED`); the rows of one entity key — a zone's snapshots, tombstone and
 * audit records — are published in `seq` order, and a failing row backs off
 * on its own (equal-jitter exponential) while the other zones keep flowing.
 */
export function outboxModuleOptions(config: Config): OutboxModuleOptions {
  return {
    mode: 'per-key',
    autoStart: config.OUTBOX_RELAY_ENABLED,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    retentionMs: config.OUTBOX_RETENTION_HOURS * 3_600_000,
    retry: {
      baseMs: config.OUTBOX_RETRY_BASE_MS,
      maxMs: config.OUTBOX_RETRY_MAX_MS,
    },
  };
}

/**
 * The transactional outbox of the service (spec §13.6): the kit's
 * `OutboxRelay` (exported through `OutboxModule`) and the publication limits
 * of the NATS server. Requires `DatabaseModule` and `NatsModule` (streams
 * `GEO` and `AUDIT` produced). Rows are written by the zones unit of work
 * with the kit's `enqueueEvent` and `AuditService.enqueue`.
 */
@Module({
  imports: [
    OutboxModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Config) => outboxModuleOptions(config),
    }),
  ],
  providers: [PublicationLimits],
  exports: [OutboxModule, PublicationLimits],
})
export class GeoOutboxModule {}
