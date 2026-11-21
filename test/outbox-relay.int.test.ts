import { setTimeout as sleep } from 'node:timers/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import {
  enqueueEvent,
  EventPublisher,
  type PublishOptions,
} from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GeoOutboxRelay } from '../src/modules/outbox/geo-outbox.relay.js';
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

/** A publisher that records, can fail, and is slow enough to interleave relays. */
class RecordingPublisher {
  readonly published: Published[] = [];
  failuresLeft = 0;

  async publishEvent<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
    options: PublishOptions = {},
  ): Promise<void> {
    await sleep(Math.random() * 3);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('TIMEOUT: no responders');
    }
    this.published.push({ id: options.id ?? '', type, data });
  }
}

/**
 * The relay without its loop (OUTBOX_RELAY_ENABLED=false): claims with
 * FOR UPDATE SKIP LOCKED, per-key order, retries with backoff, permanent
 * failures, several relays at once.
 */
describe('GeoOutboxRelay', () => {
  let service: TestService;

  /** A relay of the test app's pool with another publisher. */
  function relayWith(
    publisher: EventPublisher | RecordingPublisher,
    batchSize = 100,
  ): GeoOutboxRelay {
    return new GeoOutboxRelay(
      service.pool,
      // The relay only calls publishEvent, which RecordingPublisher implements.
      publisher as EventPublisher,
      new MetricsService(),
      {
        ...service.config,
        OUTBOX_RELAY_ENABLED: false,
        OUTBOX_BATCH_SIZE: batchSize,
        OUTBOX_RETRY_BASE_MS: 50,
        OUTBOX_RETRY_MAX_MS: 200,
      },
    );
  }

  async function enqueue(id: string, version: number): Promise<string> {
    return enqueueEvent(
      service.pool,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      snapshot(id, version),
    );
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

  it('publishes one row per zone per pass, oldest first', async () => {
    const zone = newId();
    const other = newId();
    await enqueue(zone, 1);
    await enqueue(zone, 2);
    await enqueue(other, 1);
    const publisher = new RecordingPublisher();
    const relay = relayWith(publisher);

    expect(await relay.relayOnce()).toEqual({
      claimed: 2,
      published: 2,
      rejected: 0,
      failed: 0,
    });
    expect(await relay.relayOnce()).toMatchObject({ claimed: 1, published: 1 });
    expect(await relay.relayOnce()).toMatchObject({ claimed: 0 });
    expect(
      publisher.published
        .filter((item) => (item.data as ZoneSnapshotV1).id === zone)
        .map((item) => (item.data as ZoneSnapshotV1).name),
    ).toEqual(['v1', 'v2']);
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
    const { rows } = await service.pool.query<{ attempts: number }>(
      'SELECT attempts FROM outbox WHERE id = $1 AND published_at IS NOT NULL',
      [rowId],
    );
    expect(rows).toEqual([{ attempts: 1 }]);
  });

  it('retries a failed publication after a backoff, keeping the zone order', async () => {
    const zone = newId();
    const first = await enqueue(zone, 1);
    await enqueue(zone, 2);
    const publisher = new RecordingPublisher();
    publisher.failuresLeft = 1;
    const relay = relayWith(publisher);

    expect(await relay.relayOnce()).toMatchObject({ failed: 1, published: 0 });
    const { rows } = await service.pool.query<{
      attempts: number;
      last_error: string;
      waiting: boolean;
    }>(
      `SELECT attempts, last_error, next_attempt_at > clock_timestamp() AS waiting
         FROM outbox WHERE id = $1`,
      [first],
    );
    expect(rows[0]).toMatchObject({
      attempts: 1,
      last_error: 'TIMEOUT: no responders',
    });
    // While the head waits for its retry, the zone's next row stays queued.
    if (rows[0]?.waiting === true) {
      expect(await relay.relayOnce()).toMatchObject({ claimed: 0 });
    }

    await sleep(250);
    expect(await relay.relayOnce()).toMatchObject({ published: 1 });
    expect(await relay.relayOnce()).toMatchObject({ published: 1 });
    expect(
      publisher.published.map((item) => (item.data as ZoneSnapshotV1).name),
    ).toEqual(['v1', 'v2']);
  });

  it('marks rows that can never be published as failed and moves on', async () => {
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

    expect(await relay.relayOnce()).toMatchObject({ rejected: 1 });
    expect(await relay.relayOnce()).toMatchObject({ published: 1 });
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
          if (result.claimed === 0) {
            const { rows } = await service.pool.query<{ left: string }>(
              'SELECT count(*) AS left FROM outbox WHERE published_at IS NULL',
            );
            if (rows[0]?.left === '0') return;
            await sleep(5);
          }
        }
      }),
    );

    expect(publisher.published).toHaveLength(40);
    expect(new Set(publisher.published.map((item) => item.id)).size).toBe(40);
    for (const zone of zones) {
      expect(
        publisher.published
          .filter((item) => (item.data as ZoneSnapshotV1).id === zone)
          .map((item) => (item.data as ZoneSnapshotV1).name),
      ).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    }
  });

  it('deletes published rows after the retention and keeps failed ones', async () => {
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
