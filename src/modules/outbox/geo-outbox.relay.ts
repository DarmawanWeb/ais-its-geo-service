import { setTimeout as sleep } from 'node:timers/promises';

import {
  type EventPayload,
  type EventType,
  isEventType,
} from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  InjectPool,
  type Pool,
  type PoolClient,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';

import type { Config } from '../../config.js';
import {
  errorText,
  isPermanentPublishError,
  outboxRetryDelayMs,
} from './outbox-policy.js';

/*
 * LOCAL WORKAROUND (reported in platformIssues): the kit's `OutboxRelay`
 * (`@darmawanweb/ais-its-nest/nats`) lets one replica relay at a time behind
 * a transaction-scoped advisory lock, orders rows by the application clock
 * (`created_at`) and stops the whole batch at the first failure. The geo
 * service needs the relay of spec §13.6 / the platform task: rows claimed
 * with `FOR UPDATE SKIP LOCKED` so every replica can relay, strict order per
 * ordering key (per zone on the compacted GEO stream) from the database
 * sequence, and per-row retries with backoff. It still uses the kit's
 * public API: rows are written with `enqueueEvent()` into a table with the
 * kit's `outboxTableSql()` columns, and published with `EventPublisher`
 * (envelope id = outbox id = `Nats-Msg-Id`). Metric names match the kit's.
 */

/**
 * Claims the oldest pending row of each ordering key (head of line), at most
 * `$1` rows, skipping rows locked by another relay. A key whose head is
 * locked or waiting for its retry is skipped as a whole, which keeps the
 * per-key order across replicas. The outer state predicates are re-checked
 * on the latest row version after a concurrent commit (EvalPlanQual).
 */
const CLAIM_SQL = `
  SELECT o.id, o.type, o.entity_key, o.data, o.created_at, o.attempts
    FROM outbox o
   WHERE o.published_at IS NULL
     AND o.failed_at IS NULL
     AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= clock_timestamp())
     AND o.id IN (SELECT DISTINCT ON (h.ordering_key) h.id
                    FROM outbox h
                   WHERE h.published_at IS NULL AND h.failed_at IS NULL
                   ORDER BY h.ordering_key, h.seq)
   ORDER BY o.seq
   LIMIT $1
     FOR UPDATE OF o SKIP LOCKED`;

/** A claimed outbox row. */
interface OutboxRow {
  readonly id: string;
  readonly type: string;
  readonly entity_key: string | null;
  readonly data: unknown;
  readonly created_at: Date;
  readonly attempts: number;
}

/** Outcome of one relay pass. */
export interface OutboxRelayPass {
  /** Rows claimed by this pass. */
  readonly claimed: number;
  /** Rows published (acknowledged by JetStream). */
  readonly published: number;
  /** Rows marked failed: they can never be published. */
  readonly rejected: number;
  /** Rows whose publication failed and that will be retried after a backoff. */
  readonly failed: number;
}

/** Settings of the relay (from `OUTBOX_*`, overridable in tests). */
export interface OutboxRelaySettings {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly retentionMs: number;
}

/** The relay settings of a configuration. */
export function outboxRelaySettings(config: Config): OutboxRelaySettings {
  return {
    enabled: config.OUTBOX_RELAY_ENABLED,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    retryBaseMs: config.OUTBOX_RETRY_BASE_MS,
    retryMaxMs: config.OUTBOX_RETRY_MAX_MS,
    retentionMs: config.OUTBOX_RETENTION_HOURS * 3_600_000,
  };
}

/** How often published rows past their retention are deleted. */
const CLEANUP_INTERVAL_MS = 10 * 60_000;

/**
 * Publishes the transactional outbox to NATS JetStream (GEO zone snapshots
 * and tombstones, AUDIT records). Every pass claims rows in one
 * transaction, publishes them in sequence order and marks them
 * `published_at`; a transient failure schedules the row's retry
 * (`next_attempt_at`, exponential backoff with jitter) and ends the pass, a
 * permanent one marks it `failed_at`. Delivery is at least once: a crash
 * between the publication and the commit republishes the row with the same
 * `Nats-Msg-Id`, which JetStream deduplicates within 2 minutes.
 *
 * Metrics: `aisits_outbox_relayed_total{type,outcome}`,
 * `aisits_outbox_pending`, `aisits_outbox_oldest_pending_seconds`,
 * `aisits_outbox_failed_rows`, `aisits_outbox_relay_pass_duration_seconds`.
 */
@Injectable()
export class GeoOutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('OutboxRelay');
  private readonly settings: OutboxRelaySettings;
  private readonly relayed: Counter<'type' | 'outcome'>;
  private readonly pending: Gauge;
  private readonly oldest: Gauge;
  private readonly failedRows: Gauge;
  private readonly passDuration: Histogram;
  private readonly stop = new AbortController();
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastCleanup = 0;

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly publisher: EventPublisher,
    metrics: MetricsService,
    @InjectConfig() config: Config,
  ) {
    this.settings = outboxRelaySettings(config);
    this.relayed = metrics.counter({
      name: 'outbox_relayed_total',
      help: 'Outbox rows relayed by event type and outcome (published, failed, rejected).',
      labelNames: ['type', 'outcome'],
    });
    this.pending = metrics.gauge({
      name: 'outbox_pending',
      help: 'Outbox rows waiting to be published.',
    });
    this.oldest = metrics.gauge({
      name: 'outbox_oldest_pending_seconds',
      help: 'Age of the oldest outbox row waiting to be published, seconds.',
    });
    this.failedRows = metrics.gauge({
      name: 'outbox_failed_rows',
      help: 'Outbox rows that can never be published (failed_at set), kept for inspection.',
    });
    this.passDuration = metrics.histogram({
      name: 'outbox_relay_pass_duration_seconds',
      help: 'Duration of one outbox relay pass (claim, publish, mark), seconds.',
    });
  }

  /** Starts the relay loop (migrations ran in `onModuleInit`). */
  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      this.logger.log('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.loop = this.run();
  }

  /** Stops the loop after the current pass (before NATS and the pool close). */
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    this.wake?.();
    await this.loop;
  }

  /** Wakes the relay now (call after committing outbox rows). */
  notify(): void {
    this.wake?.();
  }

  /**
   * One pass: claims up to `batchSize` head-of-line rows and publishes them.
   * Never throws for publication failures (they are recorded on the rows).
   */
  async relayOnce(): Promise<OutboxRelayPass> {
    const stopTimer = this.passDuration.startTimer();
    try {
      const pass = await withTransaction(this.pool, (client) =>
        this.relayClaimed(client),
      );
      await this.updateGauges();
      return pass;
    } finally {
      stopTimer();
    }
  }

  /** Deletes published rows older than the retention; returns how many. */
  async cleanup(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM outbox WHERE published_at < $1',
      [new Date(Date.now() - this.settings.retentionMs)],
    );
    return result.rowCount ?? 0;
  }

  private async relayClaimed(client: PoolClient): Promise<OutboxRelayPass> {
    const { rows } = await client.query<OutboxRow>(CLAIM_SQL, [
      this.settings.batchSize,
    ]);
    const published: string[] = [];
    let rejected = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.publish(row);
        published.push(row.id);
        this.relayed.inc({ type: row.type, outcome: 'published' });
      } catch (error) {
        if (isPermanentPublishError(error) || !isEventType(row.type)) {
          rejected += 1;
          await this.markFailed(client, row, error);
          continue;
        }
        failed += 1;
        await this.scheduleRetry(client, row, error);
        // The broker is most likely unavailable: end the pass instead of
        // waiting for one timeout per claimed row.
        break;
      }
    }
    if (published.length > 0) {
      await client.query(
        'UPDATE outbox SET published_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL WHERE id = ANY($1::uuid[])',
        [published],
      );
    }
    return {
      claimed: rows.length,
      published: published.length,
      rejected,
      failed,
    };
  }

  private async publish(row: OutboxRow): Promise<void> {
    if (!isEventType(row.type)) {
      throw new Error(`Unknown event type "${row.type}"`);
    }
    await this.publisher.publishEvent(
      row.type,
      // Written by enqueueEvent from a validated payload of `row.type`;
      // publishEvent validates it again against the contracts schema.
      row.data as EventPayload<EventType>,
      {
        id: row.id,
        time: row.created_at,
        entityKey: row.entity_key ?? undefined,
      },
    );
  }

  private async markFailed(
    client: PoolClient,
    row: OutboxRow,
    error: unknown,
  ): Promise<void> {
    this.relayed.inc({ type: row.type, outcome: 'rejected' });
    this.logger.error(
      `Outbox row ${row.id} (${row.type}) can never be published and is marked failed: ${errorText(error)}`,
    );
    await client.query(
      'UPDATE outbox SET attempts = attempts + 1, last_error = $2, failed_at = clock_timestamp() WHERE id = $1',
      [row.id, errorText(error)],
    );
  }

  private async scheduleRetry(
    client: PoolClient,
    row: OutboxRow,
    error: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const delayMs = outboxRetryDelayMs(attempts, {
      baseMs: this.settings.retryBaseMs,
      maxMs: this.settings.retryMaxMs,
    });
    this.relayed.inc({ type: row.type, outcome: 'failed' });
    this.logger.warn(
      `Publishing outbox row ${row.id} (${row.type}) failed (attempt ${attempts}), retrying in ${delayMs} ms: ${errorText(error)}`,
    );
    await client.query(
      "UPDATE outbox SET attempts = $2, last_error = $3, next_attempt_at = clock_timestamp() + $4 * interval '1 millisecond' WHERE id = $1",
      [row.id, attempts, errorText(error), delayMs],
    );
  }

  private async updateGauges(): Promise<void> {
    const { rows } = await this.pool.query<{
      pending: string;
      oldest: Date | null;
      failed: string;
    }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS pending,
              min(created_at) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS oldest,
              count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
         FROM outbox
        WHERE published_at IS NULL`,
    );
    const row = rows[0];
    this.pending.set(Number(row?.pending ?? 0));
    this.failedRows.set(Number(row?.failed ?? 0));
    const oldest = row?.oldest ?? null;
    this.oldest.set(
      oldest === null ? 0 : Math.max(0, (Date.now() - oldest.getTime()) / 1000),
    );
  }

  private async maybeCleanup(): Promise<void> {
    if (Date.now() - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = Date.now();
    const deleted = await this.cleanup();
    if (deleted > 0) this.logger.debug(`Deleted ${deleted} published outbox rows`);
  }

  /** Read through a method: the signal changes while the loop awaits. */
  private isStopping(): boolean {
    return this.stop.signal.aborted;
  }

  private async run(): Promise<void> {
    const { pollIntervalMs, retryMaxMs } = this.settings;
    let idleMs = pollIntervalMs;
    while (!this.isStopping()) {
      let progressed = false;
      try {
        const pass = await this.relayOnce();
        progressed = pass.published + pass.rejected > 0;
        idleMs =
          pass.failed > 0 ? Math.min(idleMs * 2, retryMaxMs) : pollIntervalMs;
        await this.maybeCleanup();
      } catch (error) {
        idleMs = Math.min(idleMs * 2, retryMaxMs);
        this.logger.error(`Outbox relay pass failed: ${errorText(error)}`);
      }
      // Drain the backlog back to back (one row per ordering key per pass).
      if (progressed) continue;
      await this.idle(idleMs);
    }
  }

  /** Waits `ms`, or less when notified or stopped. */
  private async idle(ms: number): Promise<void> {
    if (this.isStopping()) return;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      void sleep(ms, undefined, { signal: this.stop.signal, ref: false })
        .catch(() => undefined)
        .then(resolve);
    });
    this.wake = undefined;
  }
}
