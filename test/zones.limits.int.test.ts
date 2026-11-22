import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idOf, square, zoneBody } from './support/fixtures.js';
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

/** A LineString whose positions all have 9 significant decimals (about 28 bytes each). */
function preciseLine(vertices: number) {
  return {
    type: 'LineString',
    coordinates: Array.from({ length: vertices }, (_, index) => [
      Number((100.123456789 + index * 1.234567891e-4).toFixed(9)),
      Number((1.123456789 + (index % 2) * 1.11111111e-4).toFixed(9)),
    ]),
  };
}

/** Quotas per owner and the NATS publication budget of zone writes. */
describe('zone write limits', () => {
  let service: TestService;

  async function zoneCount(): Promise<number> {
    const { rows } = await service.pool.query<{ zones: string }>(
      'SELECT count(*) AS zones FROM zones',
    );
    return Number(rows[0]?.zones);
  }

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

  it('refuses a zone whose snapshot exceeds the NATS max_payload (422) and stores nothing', async () => {
    // The test NATS runs with the 1 MiB default; 45 000 vertices with 9
    // decimals make a snapshot of about 1.3 MB.
    const before = await zoneCount();
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminB,
      body: zoneBody({ kind: 'pipeline', geometry: preciseLine(45_000) }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>()).toMatchObject({
      code: 'ZONE_SNAPSHOT_TOO_LARGE',
      maxBytes: 1024 * 1024 - 1024,
    });
    expect(
      response.json<{ snapshotBytes: number }>().snapshotBytes,
    ).toBeGreaterThan(1024 * 1024);
    expect(await zoneCount()).toBe(before);
    const { rows } = await service.pool.query<{ failed: string }>(
      'SELECT count(*) AS failed FROM outbox WHERE failed_at IS NOT NULL',
    );
    expect(rows[0]?.failed).toBe('0');
  });
});
