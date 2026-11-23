import { setTimeout as sleep } from 'node:timers/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  enqueueEvent,
  EventPublisher,
  OutboxRelay,
  type PublishOptions,
} from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { outboxModuleOptions } from '../src/modules/outbox/outbox.module.js';
import { changelogRelease, listItem, readDoc } from './support/docs.js';
import { lastZoneMessage } from './support/geo-stream.js';
import { startTestService, type TestService } from './support/test-service.js';

/** A valid snapshot of zone `id`, version `version` (in the name). */
function snapshot(id: string, version: number): ZoneSnapshotV1 {
  return {
    id,
    orgId: null,
    code: `relay-${id.slice(-6)}`,
    name: `v${version}`,
    kind: 'restricted',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [104, 1],
          [104.1, 1],
          [104.1, 1.1],
          [104, 1.1],
          [104, 1],
        ],
      ],
    },
    bufferM: 0,
    active: true,
    alertOnEnter: false,
    properties: {},
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, version)).toISOString(),
  };
}

/** Publications recorded by a fake publisher. */
interface Published {
  readonly id: string;
  readonly type: EventType;
  readonly data: unknown;
}

/**
 * A publisher that records, is slow enough to interleave relays, and fails
 * the next `failuresLeft` publications of the zones in `failing`.
 */
class RecordingPublisher {
  readonly published: Published[] = [];
  readonly failing = new Set<string>();
  failuresLeft = 0;

  async publishEvent<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
    options: PublishOptions = {},
  ): Promise<void> {
    await sleep(Math.random() * 3);
    const zoneId = (data as { id?: string }).id ?? '';
    if (this.failing.has(zoneId) && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('TIMEOUT: no responders');
    }
    this.published.push({ id: options.id ?? '', type, data });
  }

  namesOf(zoneId: string): string[] {
    return this.published
      .filter((item) => (item.data as ZoneSnapshotV1).id === zoneId)
      .map((item) => (item.data as ZoneSnapshotV1).name);
  }
}

/**
 * The kit's OutboxRelay on geo's outbox table, with the options geo derives
 * from its configuration (OUTBOX_RELAY_ENABLED=false: no loop, passes run
 * by the test): per-key mode, FOR UPDATE SKIP LOCKED, per-zone order, a
 * failing zone backing off alone, parked rows, several relays at once.
 */
describe('outbox relay (kit OutboxRelay, per-key mode)', () => {
  let service: TestService;

  /** A relay of the test app's pool with another publisher. */
  function relayWith(
    publisher: EventPublisher | RecordingPublisher,
    batchSize = 100,
  ): OutboxRelay {
    return new OutboxRelay(
      service.pool,
      // The relay only calls publishEvent, which RecordingPublisher implements.
      publisher as EventPublisher,
      {
        ...outboxModuleOptions({
          ...service.config,
          OUTBOX_BATCH_SIZE: batchSize,
          OUTBOX_RETRY_BASE_MS: 50,
          OUTBOX_RETRY_MAX_MS: 200,
        }),
        autoStart: false,
      },
      null,
    );
  }

  async function enqueue(id: string, version: number): Promise<string> {
    return enqueueEvent(
      service.pool,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      snapshot(id, version),
    );
  }

  async function pendingRows(): Promise<number> {
    const { rows } = await service.pool.query<{ left: string }>(
      'SELECT count(*) AS left FROM outbox WHERE published_at IS NULL AND failed_at IS NULL',
    );
    return Number(rows[0]?.left);
  }

  beforeAll(async () => {
    service = await startTestService({ OUTBOX_RELAY_ENABLED: 'false' });
  });

  beforeEach(async () => {
    await service.reset();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('runs in per-key mode on the migrated table and its indexes', async () => {
    expect(await relayWith(new RecordingPublisher()).mode()).toBe('per-key');
    expect(await service.app.get(OutboxRelay).mode()).toBe('per-key');
    const { rows } = await service.pool.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'outbox'`,
    );
    const definitions = new Map(
      rows.map((row) => [row.indexname, row.indexdef]),
    );
    expect(definitions.get('outbox_pending_key_idx')).toContain(
      '(entity_key, seq)',
    );
    for (const name of [
      'outbox_pending_idx',
      'outbox_pending_seq_idx',
      'outbox_retry_idx',
      'outbox_failed_idx',
    ]) {
      expect(definitions.has(name)).toBe(true);
    }
  });

  it('publishes the rows of every zone in insertion order', async () => {
    const zone = newId();
    const other = newId();
    await enqueue(zone, 1);
    await enqueue(other, 1);
    await enqueue(zone, 2);
    await enqueue(zone, 3);
    const publisher = new RecordingPublisher();
    const relay = relayWith(publisher);

    expect(await relay.relayOnce()).toMatchObject({
      mode: 'per-key',
      published: 4,
      rejected: 0,
      failed: false,
    });
    expect(await relay.relayOnce()).toMatchObject({ published: 0 });
    expect(publisher.namesOf(zone)).toEqual(['v1', 'v2', 'v3']);
    expect(publisher.namesOf(other)).toEqual(['v1']);
  });

  it('claims at most OUTBOX_BATCH_SIZE due rows a pass, so a busy zone takes several passes (CHANGELOG 0.2.0)', async () => {
    const busy = newId();
    const other = newId();
    for (let version = 1; version <= 5; version += 1) {
      await enqueue(busy, version);
    }
    await enqueue(other, 1);
    const publisher = new RecordingPublisher();
    const relay = relayWith(publisher, 2);

    const passes: { published: number; busy: string[]; other: string[] }[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const { published } = await relay.relayOnce();
      passes.push({
        published,
        busy: publisher.namesOf(busy),
        other: publisher.namesOf(other),
      });
    }
    // The oldest due rows of all zones are claimed: the other zone's row
    // waits for the pass that reaches it, the busy zone stays in order.
    expect(passes).toEqual([
      { published: 2, busy: ['v1', 'v2'], other: [] },
      { published: 2, busy: ['v1', 'v2', 'v3', 'v4'], other: [] },
      { published: 2, busy: ['v1', 'v2', 'v3', 'v4', 'v5'], other: ['v1'] },
      { published: 0, busy: ['v1', 'v2', 'v3', 'v4', 'v5'], other: ['v1'] },
    ]);

    const entry = listItem(
      changelogRelease(readDoc('CHANGELOG.md'), '0.2.0'),
      'The transactional outbox is relayed',
    );
    expect(entry).toContain(
      'a pass claims up to `OUTBOX_BATCH_SIZE` due rows (`FOR UPDATE SKIP LOCKED`)',
    );
    expect(entry).toContain('published over several passes');
    expect(entry).not.toContain('in one pass');
  });

  it('publishes through JetStream with the outbox id as Nats-Msg-Id', async () => {
    const zone = newId();
    const rowId = await enqueue(zone, 7);
    const relay = relayWith(service.app.get(EventPublisher));

    expect(await relay.relayOnce()).toMatchObject({ published: 1 });
    const stored = await lastZoneMessage(service.app, zone);
    expect(stored).toMatchObject({
      msgId: rowId,
      envelope: { id: rowId, data: { id: zone, name: 'v7' } },
    });
    const { rows } = await service.pool.query<{ published: boolean }>(
      'SELECT published_at IS NOT NULL AS published FROM outbox WHERE id = $1',
      [rowId],
    );
    expect(rows).toEqual([{ published: true }]);
  });

  it('backs off a failing zone alone, keeping its order, while other zones flow', async () => {
    const failing = newId();
    const healthy = newId();
    const first = await enqueue(failing, 1);
    await enqueue(failing, 2);
    await enqueue(healthy, 1);
    const publisher = new RecordingPublisher();
    publisher.failing.add(failing);
    publisher.failuresLeft = 1;
    const relay = relayWith(publisher);

    expect(await relay.relayOnce()).toMatchObject({
      published: 1,
      failed: true,
      retrying: 1,
    });
    expect(publisher.namesOf(healthy)).toEqual(['v1']);
    const { rows } = await service.pool.query<{
      attempts: number;
      last_error: string;
      scheduled: boolean;
    }>(
      `SELECT attempts, last_error, next_attempt_at IS NOT NULL AS scheduled
         FROM outbox WHERE id = $1`,
      [first],
    );
    expect(rows[0]).toEqual({
      attempts: 1,
      last_error: 'TIMEOUT: no responders',
      scheduled: true,
    });

    // After the backoff (50-200 ms), the zone resumes in order.
    await sleep(250);
    expect(await relay.relayOnce()).toMatchObject({ published: 2 });
    expect(publisher.namesOf(failing)).toEqual(['v1', 'v2']);
  });

  it('parks rows that can never be published and moves on with the zone', async () => {
    const zone = newId();
    const poison = newId();
    // A row whose payload violates the contract (written around enqueueEvent).
    await service.pool.query(
      `INSERT INTO outbox (id, type, entity_key, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        poison,
        EVENT_TYPES.GEO_ZONE_UPSERTED,
        zone,
        JSON.stringify({ id: zone }),
      ],
    );
    await enqueue(zone, 2);
    const relay = relayWith(service.app.get(EventPublisher));

    expect(await relay.relayOnce()).toMatchObject({
      rejected: 1,
      published: 1,
    });
    const { rows } = await service.pool.query<{
      failed: boolean;
      last_error: string;
    }>(
      'SELECT failed_at IS NOT NULL AS failed, last_error FROM outbox WHERE id = $1',
      [poison],
    );
    expect(rows[0]?.failed).toBe(true);
    expect(rows[0]?.last_error).toContain('Invalid');
    expect(await lastZoneMessage(service.app, zone)).toMatchObject({
      envelope: { data: { name: 'v2' } },
    });
  });

  it('lets several relays drain the outbox without duplicates or reordering', async () => {
    const zones = Array.from({ length: 8 }, () => newId());
    for (let version = 1; version <= 5; version += 1) {
      for (const zone of zones) await enqueue(zone, version);
    }
    const publisher = new RecordingPublisher();
    const relays = [
      relayWith(publisher, 3),
      relayWith(publisher, 3),
      relayWith(publisher, 3),
    ];

    await Promise.all(
      relays.map(async (relay) => {
        for (let pass = 0; pass < 200; pass += 1) {
          const result = await relay.relayOnce();
          if (result.published === 0) {
            if ((await pendingRows()) === 0) return;
            await sleep(5);
          }
        }
      }),
    );

    expect(publisher.published).toHaveLength(40);
    expect(new Set(publisher.published.map((item) => item.id)).size).toBe(40);
    for (const zone of zones) {
      expect(publisher.namesOf(zone)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    }
  });

  it('deletes published rows after the retention and keeps parked ones', async () => {
    const zone = newId();
    const published = await enqueue(zone, 1);
    const failed = newId();
    await service.pool.query(
      `INSERT INTO outbox (id, type, entity_key, data, failed_at, published_at)
       VALUES ($1, $2, $3, '{}'::jsonb, now() - interval '3 days', NULL)`,
      [failed, EVENT_TYPES.GEO_ZONE_UPSERTED, zone],
    );
    await service.pool.query(
      `UPDATE outbox SET published_at = now() - interval '2 days' WHERE id = $1`,
      [published],
    );

    expect(await relayWith(new RecordingPublisher()).cleanup()).toBe(1);
    const { rows } = await service.pool.query<{ id: string }>(
      'SELECT id FROM outbox',
    );
    expect(rows).toEqual([{ id: failed }]);
  });
});
