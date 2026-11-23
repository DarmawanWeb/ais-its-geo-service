import { randomUUID } from 'node:crypto';

import { ZONE_MAX_VERTICES } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { eventMessageSize, OutboxRelay } from '@darmawanweb/ais-its-nest/nats';
import { startTestInfra, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listItem, metricsTableRow, readDoc } from './support/docs.js';
import { idOf, square, zoneBody } from './support/fixtures.js';
import { lastZoneMessage } from './support/geo-stream.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';

interface Problem {
  code: string;
  status: number;
  [extra: string]: unknown;
}

/** A zig-zag LineString of `vertices` positions (about 18 bytes each as JSON). */
function zigzag(vertices: number) {
  return {
    type: 'LineString',
    coordinates: Array.from({ length: vertices }, (_, index) => [
      Number((100 + index * 1e-5).toFixed(5)),
      1 + (index % 2) * 1e-5,
    ]),
  };
}

/**
 * A LineString south-west of the origin whose positions all have 9 decimals
 * (up to `[-100.123456789,-10.123456789],`, 31 bytes), as wide as stored
 * positions get: 50 000 of them make a snapshot of about 1.5 MB.
 */
function wideLine(vertices: number) {
  return {
    type: 'LineString',
    coordinates: Array.from({ length: vertices }, (_, index) => [
      Number((-100.123456789 - index * 1.234567891e-5).toFixed(9)),
      Number((-10.123456789 - (index % 2) * 1.11111111e-4).toFixed(9)),
    ]),
  };
}

/** Quotas per owner. */
describe('zone write quotas', () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService({
      ZONE_QUOTA_MAX_ZONES: '2',
      ZONE_QUOTA_MAX_VERTICES: '50000',
    });
    await service.reset();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('caps the zones and the vertices of an organization (409), per owner', async () => {
    const line = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ kind: 'pipeline', geometry: zigzag(30_000) }),
    });
    expect(line.statusCode).toBe(201);

    // 30 000 + 25 000 vertices > 50 000.
    const tooDetailed = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ kind: 'pipeline', geometry: zigzag(25_000) }),
    });
    expect(tooDetailed.statusCode).toBe(409);
    expect(tooDetailed.json<Problem>()).toMatchObject({
      code: 'ZONE_QUOTA_EXCEEDED',
      resource: 'vertices',
      orgId: USERS.orgAdminA.orgId,
      used: 30_000,
      requested: 25_000,
      limit: 50_000,
    });

    const second = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody(),
    });
    expect(second.statusCode).toBe(201);
    const third = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody(),
    });
    expect(third.statusCode).toBe(409);
    expect(third.json<Problem>()).toMatchObject({
      code: 'ZONE_QUOTA_EXCEEDED',
      resource: 'zones',
      used: 2,
      limit: 2,
    });

    // A PATCH growing the geometry is checked too; another owner is not affected.
    const grow = await service.request('PATCH', `${ZONES}/${idOf(second)}`, {
      user: USERS.orgAdminA,
      body: { geometry: zigzag(20_001), kind: 'pipeline' },
    });
    expect(grow.statusCode).toBe(409);
    for (const user of [USERS.orgAdminB, USERS.authority]) {
      const other = await service.request('POST', ZONES, {
        user,
        body: zoneBody({
          geometry: square(105, 2),
          ...(user === USERS.authority ? { global: true } : {}),
        }),
      });
      expect(other.statusCode).toBe(201);
    }
  });
});

/**
 * Zones near the input limits through NATS (the test server runs with the
 * platform's 4MB max_payload): a valid zone of about 1.5 MB is stored and
 * published, the same zone is refused with 422 by a service whose NATS only
 * accepts 1 MB, before anything is written. The stored zone republished to
 * the 1 MB server is parked as the README's "Parked rows" entry says, and
 * recovers as it says.
 */
describe('zone snapshots near the NATS max_payload', () => {
  let service: TestService;
  let smallNats: Awaited<ReturnType<typeof startSmallNats>> | undefined;
  let smallService: TestService | undefined;
  /** The zone of about 1.5 MB stored through the 4MB server. */
  let largeZoneId: string | undefined;

  function startSmallNats() {
    return startTestInfra({ nats: { maxPayload: '1MB' } });
  }

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await smallService?.app.close();
    await smallNats?.stop();
    await service.app.close();
  });

  it('stores and publishes a valid zone of about 1.5 MB (4MB NATS)', async () => {
    // At the vertex limit, every position as wide as stored positions get.
    const geometry = wideLine(ZONE_MAX_VERTICES);
    const response = await service.request('POST', ZONES, {
      user: { roles: ['org_admin'], orgId: randomUUID() },
      body: zoneBody({ kind: 'pipeline', geometry }),
    });
    expect(response.statusCode).toBe(201);
    const id = idOf(response);
    largeZoneId = id;
    const stored = await waitFor(() => lastZoneMessage(service.app, id), {
      timeoutMs: 20_000,
    });
    if (stored.envelope.type !== EVENT_TYPES.GEO_ZONE_UPSERTED) {
      throw new Error(`unexpected ${stored.envelope.type}`);
    }
    const coordinates = (
      stored.envelope.data.geometry as { coordinates: unknown[] }
    ).coordinates;
    expect(coordinates).toHaveLength(ZONE_MAX_VERTICES);
    expect(coordinates.at(-1)).toEqual(geometry.coordinates.at(-1));
    // The message is well above the 1 MiB NATS default (about 1.5 MB).
    expect(
      eventMessageSize(EVENT_TYPES.GEO_ZONE_UPSERTED, stored.envelope.data),
    ).toBeGreaterThan(1_400_000);
    const { rows } = await service.pool.query<{ failed: string }>(
      `SELECT count(*) AS failed FROM outbox WHERE failed_at IS NOT NULL AND entity_key = $1`,
      [id],
    );
    expect(rows[0]?.failed).toBe('0');
  });

  it('refuses the same zone with 422 before anything is enqueued (1MB NATS)', async () => {
    smallNats = await startSmallNats();
    smallService = await startTestService({
      NATS_URL: smallNats.nats.url,
      OUTBOX_RELAY_ENABLED: 'false',
    });
    const code = `oversized-${randomUUID().slice(0, 8)}`;
    const outboxBefore = await outboxRows(smallService);
    const response = await smallService.request('POST', ZONES, {
      user: { roles: ['org_admin'], orgId: randomUUID() },
      body: zoneBody({
        code,
        kind: 'pipeline',
        geometry: wideLine(ZONE_MAX_VERTICES),
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>()).toMatchObject({
      code: 'ZONE_SNAPSHOT_TOO_LARGE',
      maxBytes: 1024 * 1024,
    });
    expect(
      response.json<{ snapshotBytes: number }>().snapshotBytes,
    ).toBeGreaterThan(1024 * 1024);
    const { rows } = await smallService.pool.query<{ zones: string }>(
      'SELECT count(*) AS zones FROM zones WHERE code = $1',
      [code],
    );
    expect(rows[0]?.zones).toBe('0');
    expect(await outboxRows(smallService)).toBe(outboxBefore);
  });

  it('parks the stored zone republished to the 1MB server, counted as rejected (README "Parked rows")', async () => {
    const zoneId = largeZoneId;
    const small = smallService;
    if (zoneId === undefined || small === undefined) {
      throw new Error('Runs after the tests above (stored zone, 1MB service)');
    }
    // From here on only the 1MB server is published to, as after lowering
    // its max_payload: the 4MB service stops relaying, the passes of the
    // 1MB service's relay run here.
    await service.app.get(OutboxRelay).beforeApplicationShutdown();
    const republish = await small.request('POST', `${ZONES}/republish`, {
      user: USERS.superAdmin,
    });
    expect(republish.statusCode).toBe(202);
    expect((await drain(small.app.get(OutboxRelay))).rejected).toBe(1);

    const readme = readDoc('README.md');
    const entry = listItem(readme, '_Parked rows_');
    // The entry's query shows the parked row and why.
    const { rows } = await small.pool.query<{
      type: string;
      entity_key: string;
      last_error: string;
    }>(statement(entry, 'SELECT'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: EVENT_TYPES.GEO_ZONE_UPSERTED,
      entity_key: zoneId,
    });
    expect(rows[0]?.last_error).toContain(
      'exceeds the NATS max_payload of 1048576 bytes',
    );
    // The publisher refused the message (EventTooLargeError), the relay
    // parked the row: the metrics the entry names.
    const metrics = await scrapeMetrics(small);
    const rejected = {
      type: EVENT_TYPES.GEO_ZONE_UPSERTED,
      outcome: 'rejected',
    };
    expect(
      sampleValue(metrics, 'aisits_events_published_total', rejected),
    ).toBe(1);
    expect(sampleValue(metrics, 'aisits_outbox_relayed_total', rejected)).toBe(
      1,
    );
    expect(sampleValue(metrics, 'aisits_outbox_failed_rows')).toBe(1);
    expect(entry).toContain('`aisits_outbox_failed_rows > 0`');
    expect(entry).toContain(
      '`aisits_outbox_relayed_total{outcome="rejected"}`',
    );
    expect(entry).toContain(
      '`aisits_events_published_total{outcome="rejected"}`',
    );
    // Every outcome these counters reported is in the metrics table.
    const reported = {
      aisits_events_published_total: ['rejected', 'stored'],
      aisits_outbox_relayed_total: ['published', 'rejected'],
    };
    for (const [metric, outcomes] of Object.entries(reported)) {
      expect(outcomesOf(metrics, metric)).toEqual(outcomes);
      const row = metricsTableRow(readme, metric);
      for (const outcome of outcomes) expect(row).toContain(`\`${outcome}\``);
    }
  });

  it('recovers as the entry says: republish where the zone fits, then delete the parked rows', async () => {
    const zoneId = largeZoneId;
    if (zoneId === undefined) throw new Error('Runs after the tests above');
    const before = await lastZoneMessage(service.app, zoneId);
    if (before === null) throw new Error('The first test published the zone');
    // The 4MB server stands for the raised max_payload.
    const republish = await service.request('POST', `${ZONES}/republish`, {
      user: USERS.superAdmin,
    });
    expect(republish.statusCode).toBe(202);
    const relay = service.app.get(OutboxRelay);
    expect((await drain(relay)).rejected).toBe(0);
    const after = await lastZoneMessage(service.app, zoneId);
    expect(after?.seq).toBeGreaterThan(before.seq);
    expect(after?.envelope.data).toEqual(before.envelope.data);

    const entry = listItem(readDoc('README.md'), '_Parked rows_');
    await service.pool.query(statement(entry, 'DELETE'));
    await relay.relayOnce(); // refreshes the gauges
    expect(
      sampleValue(await scrapeMetrics(service), 'aisits_outbox_failed_rows'),
    ).toBe(0);
  });
});

/** Runs relay passes until one makes no progress; the totals of the passes. */
async function drain(
  relay: OutboxRelay,
): Promise<{ published: number; rejected: number }> {
  const total = { published: 0, rejected: 0 };
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await relay.relayOnce();
    total.published += result.published;
    total.rejected += result.rejected;
    if (result.published + result.rejected + result.deferred === 0) {
      return total;
    }
  }
  throw new Error('The outbox did not drain in 20 passes');
}

/** The SQL statement in backticks, starting with `keyword`, of a README entry. */
function statement(entry: string, keyword: 'SELECT' | 'DELETE'): string {
  const sql = new RegExp(`\`(${keyword} [^\`]+;)\``).exec(entry)?.[1];
  if (sql === undefined) throw new Error(`No ${keyword} statement: ${entry}`);
  return sql;
}

/** The `/metrics` body of a test service. */
async function scrapeMetrics(service: TestService): Promise<string> {
  const response = await service.app.inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/** A sample of the Prometheus text format. */
interface MetricSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** The samples of `metric` in a `/metrics` body. */
function samplesOf(body: string, metric: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const line of body.split('\n')) {
    const match = /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match?.[1] !== metric) continue;
    const labels: Record<string, string> = {};
    for (const [, name = '', value = ''] of (match[2] ?? '').matchAll(
      /(\w+)="([^"]*)"/g,
    )) {
      labels[name] = value;
    }
    samples.push({ labels, value: Number(match[3]) });
  }
  return samples;
}

/** The value of the sample of `metric` whose labels include `labels`. */
function sampleValue(
  body: string,
  metric: string,
  labels: Readonly<Record<string, string>> = {},
): number | undefined {
  return samplesOf(body, metric).find((sample) =>
    Object.entries(labels).every(
      ([name, value]) => sample.labels[name] === value,
    ),
  )?.value;
}

/** The `outcome` values counted by `metric`, sorted. */
function outcomesOf(body: string, metric: string): string[] {
  const outcomes = samplesOf(body, metric)
    .filter((sample) => sample.value > 0)
    .map((sample) => sample.labels.outcome)
    .filter((outcome) => outcome !== undefined);
  return [...new Set(outcomes)].sort();
}

/** Rows in the outbox (pending, published or parked). */
async function outboxRows(service: TestService): Promise<number> {
  const { rows } = await service.pool.query<{ rows: string }>(
    'SELECT count(*) AS rows FROM outbox',
  );
  return Number(rows[0]?.rows);
}
