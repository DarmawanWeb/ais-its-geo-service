import { readFile } from 'node:fs/promises';

import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BATAM_ZONE_CODE,
  MVP_DATASET_NOTE,
  PIPELINE_ZONE_CODE,
} from '../src/modules/seed/legacy-datasets.js';
import { ZoneSeeder } from '../src/modules/seed/zone-seeder.js';
import { GEOMETRY_REPAIR_METHOD } from '../src/modules/zones/zones.repository.js';
import { lastZoneMessage } from './support/geo-stream.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

interface StoredZone {
  id: string;
  code: string;
  kind: string;
  org_id: string | null;
  buffer_m: number;
  geometry_type: string;
  vertices: number;
  valid: boolean;
  properties: Record<string, unknown>;
  source: string;
}

/** `pnpm seed`: the MVP zones, idempotent by code. */
describe('ZoneSeeder', () => {
  let service: TestService;
  let seeder: ZoneSeeder;

  async function storedZones(): Promise<StoredZone[]> {
    const { rows } = await service.pool.query<StoredZone>(
      `SELECT id, code, kind, org_id, buffer_m, GeometryType(geom::geometry) AS geometry_type,
              ST_NPoints(geom::geometry) AS vertices, ST_IsValid(geom::geometry) AS valid,
              properties, source
         FROM zones ORDER BY code`,
    );
    return rows;
  }

  async function outboxRows(): Promise<number> {
    const { rows } = await service.pool.query<{ rows: string }>(
      'SELECT count(*) AS rows FROM outbox',
    );
    return Number(rows[0]?.rows);
  }

  beforeAll(async () => {
    service = await startTestService();
    await service.reset();
    seeder = service.app.get(ZoneSeeder);
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('creates the pipeline and the Batam transhipment area as global zones', async () => {
    const results = await seeder.seed();
    expect(results).toEqual([
      expect.objectContaining({
        code: PIPELINE_ZONE_CODE,
        outcome: 'created',
        repaired: false,
      }),
      expect.objectContaining({
        code: BATAM_ZONE_CODE,
        outcome: 'created',
        repaired: true,
      }),
    ]);

    const [batam, pipeline] = await storedZones();
    expect(pipeline).toMatchObject({
      code: PIPELINE_ZONE_CODE,
      kind: 'pipeline',
      org_id: null,
      buffer_m: 1750,
      geometry_type: 'LINESTRING',
      vertices: 61,
      valid: true,
      properties: {
        note: MVP_DATASET_NOTE,
        methodId: 'data.pipeline_route',
        dataset: {
          path: 'data/legacy/pipeline.json',
          sha256:
            '56f6578f062de95a5936f07340f7ba9d7270da8ac63c22017a7b4621c767e26b',
        },
      },
    });
    expect(pipeline?.properties.markers).toHaveLength(61);
    expect(pipeline?.source).toContain('data/legacy/pipeline.json');

    expect(batam).toMatchObject({
      code: BATAM_ZONE_CODE,
      kind: 'transhipment_area',
      org_id: null,
      buffer_m: 0,
      geometry_type: 'MULTIPOLYGON',
      valid: true,
      properties: {
        methodId: 'data.batam_area',
        province: 'Kepulauan Riau',
        geometryRepair: {
          method: GEOMETRY_REPAIR_METHOD,
          reason: 'Self-intersection',
          verticesBefore: 795,
          verticesAfter: 795,
          partsBefore: 73,
          partsAfter: 70,
        },
      },
    });
    // The overlapping parts are merged (union), not cut out (XOR).
    expect(batam?.vertices).toBe(795);
    // Two snapshots and two audit records (system actor).
    expect(await outboxRows()).toBe(4);
  });

  it('keeps every square metre of the legacy Batam parts (overlaps merged)', async () => {
    const file = JSON.parse(
      await readFile(
        new URL('../data/legacy/batam.json', import.meta.url),
        'utf8',
      ),
    ) as { features: { geometry: unknown }[] };
    const legacy = JSON.stringify(file.features[0]?.geometry);
    const { rows } = await service.pool.query<{
      parts: number;
      worst_uncovered_m2: number;
      area_km2: number;
      union_km2: number;
      overlap_point_inside: boolean;
    }>(
      `WITH stored AS (SELECT geom::geometry AS g FROM zones WHERE code = $2),
            legacy AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g)
       SELECT (SELECT count(*)::int FROM legacy, ST_Dump(legacy.g)) AS parts,
              (SELECT max(ST_Area(ST_Difference(d.geom, stored.g)::geography))
                 FROM legacy, stored, ST_Dump(legacy.g) AS d) AS worst_uncovered_m2,
              (SELECT ST_Area(stored.g::geography) / 1e6 FROM stored) AS area_km2,
              (SELECT ST_Area(ST_UnaryUnion(legacy.g)::geography) / 1e6 FROM legacy) AS union_km2,
              (SELECT ST_Intersects(stored.g, ST_SetSRID(ST_MakePoint(103.90444987, 0.82086512), 4326))
                 FROM stored) AS overlap_point_inside`,
      [legacy, BATAM_ZONE_CODE],
    );
    const facts = rows[0];
    expect(facts?.parts).toBe(73);
    // Every legacy part is covered, up to the float noding of the union
    // (< 1 m² per part; the XOR repair lost 36 588 m² of parts 17/19 alone).
    expect(facts?.worst_uncovered_m2).toBeLessThan(1);
    // Area of the union of the parts (7 358.689 km²), not of their XOR (7 358.643).
    expect(facts?.area_km2).toBeCloseTo(facts?.union_km2 ?? 0, 5);
    expect(facts?.area_km2).toBeCloseTo(7358.689, 2);
    // Inside legacy parts 17 and 19 (their overlap).
    expect(facts?.overlap_point_inside).toBe(true);
  });

  it('publishes the seeded zones to GEO for the detectors', async () => {
    const [, pipeline] = await storedZones();
    const message = await waitFor(
      () => lastZoneMessage(service.app, pipeline?.id ?? ''),
      { timeoutMs: 10_000 },
    );
    expect(message.envelope).toMatchObject({
      type: EVENT_TYPES.GEO_ZONE_UPSERTED,
      data: {
        code: PIPELINE_ZONE_CODE,
        kind: 'pipeline',
        bufferM: 1750,
        orgId: null,
        properties: { source: pipeline?.source },
      },
    });
  });

  it('is idempotent by code: a second run keeps the zones and writes nothing', async () => {
    const before = await storedZones();
    expect(await seeder.seed()).toEqual([
      expect.objectContaining({ outcome: 'kept' }),
      expect.objectContaining({ outcome: 'kept' }),
    ]);
    expect(await seeder.seed('update')).toEqual([
      expect.objectContaining({ outcome: 'unchanged' }),
      expect.objectContaining({ outcome: 'unchanged' }),
    ]);
    expect(await storedZones()).toEqual(before);
    expect(await outboxRows()).toBe(4);
  });

  it('keeps operator changes, unless run in update mode', async () => {
    const [, pipeline] = await storedZones();
    const changed = await service.request(
      'PATCH',
      `/api/v2/zones/${pipeline?.id ?? ''}`,
      { user: USERS.authority, body: { bufferM: 2000 } },
    );
    expect(changed.statusCode).toBe(200);

    await seeder.seed();
    expect((await storedZones())[1]?.buffer_m).toBe(2000);

    const results = await seeder.seed('update');
    expect(results[0]).toMatchObject({
      code: PIPELINE_ZONE_CODE,
      outcome: 'updated',
    });
    expect(results[1]).toMatchObject({ outcome: 'unchanged' });
    expect((await storedZones())[1]?.buffer_m).toBe(1750);
  });
});
