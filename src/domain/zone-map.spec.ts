import { describe, expect, it } from 'vitest';

import {
  exceededBudget,
  featureCollectionJson,
  featureJson,
  type MapFeatureRow,
  type MapLayerEvent,
  type MapLayerSummary,
  planFetchChunks,
  simplificationToleranceDeg,
} from './zone-map.js';

const ROW: MapFeatureRow = {
  id: '01900000-0000-7000-8000-000000000001',
  orgId: null,
  code: 'mvp-pipeline',
  name: 'Pipeline "A"',
  kind: 'pipeline',
  bufferM: 1750,
  alertOnEnter: false,
  active: true,
  properties: { note: 'MVP' },
  source: 'legacy',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  geometryJson:
    '{"type":"LineString","coordinates":[[112.6,-7.1],[112.7,-7.2]]}',
  vertices: 2,
};

const SUMMARY: MapLayerSummary = {
  truncated: true,
  truncatedBy: 'vertices',
  featureCount: 1,
  vertexCount: 2,
  limits: { maxFeatures: 10, maxVertices: 3 },
  zoom: 9,
  toleranceDeg: simplificationToleranceDeg(9),
};

async function* eventsOf(
  ...events: MapLayerEvent[]
): AsyncGenerator<MapLayerEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe('simplificationToleranceDeg', () => {
  it('is half a 512-px tile pixel in degrees of longitude', () => {
    expect(simplificationToleranceDeg(0)).toBeCloseTo(0.3515625, 10);
    expect(simplificationToleranceDeg(10)).toBeCloseTo(0.3515625 / 1024, 12);
    // Halves with every zoom level.
    expect(simplificationToleranceDeg(7) / simplificationToleranceDeg(8)).toBe(
      2,
    );
  });

  it('is 0 without a zoom and below the 6-decimal rounding (zoom >= 19)', () => {
    expect(simplificationToleranceDeg(undefined)).toBe(0);
    expect(simplificationToleranceDeg(18)).toBeGreaterThan(1e-6);
    expect(simplificationToleranceDeg(19)).toBe(0);
    expect(simplificationToleranceDeg(24)).toBe(0);
  });
});

describe('exceededBudget', () => {
  const limits = { maxFeatures: 2, maxVertices: 10 };

  it('admits a feature within both budgets, the last vertex included', () => {
    expect(exceededBudget({ features: 0, vertices: 0 }, 10, limits)).toBe(
      undefined,
    );
    expect(exceededBudget({ features: 1, vertices: 4 }, 6, limits)).toBe(
      undefined,
    );
  });

  it('names the budget the next feature would exceed', () => {
    expect(exceededBudget({ features: 2, vertices: 0 }, 1, limits)).toBe(
      'features',
    );
    expect(exceededBudget({ features: 1, vertices: 5 }, 6, limits)).toBe(
      'vertices',
    );
  });
});

describe('planFetchChunks', () => {
  const candidate = (id: string, vertexCount: number) => ({ id, vertexCount });

  it('groups candidates in order up to the vertex budget of a chunk', () => {
    const chunks = planFetchChunks(
      [
        candidate('a', 40),
        candidate('b', 60),
        candidate('c', 1),
        candidate('d', 99),
        candidate('e', 100),
      ],
      100,
    );
    expect(chunks.map((chunk) => chunk.map((item) => item.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('puts a candidate larger than the budget in a chunk of its own', () => {
    const chunks = planFetchChunks(
      [candidate('a', 5), candidate('big', 500), candidate('b', 5)],
      100,
    );
    expect(chunks.map((chunk) => chunk.map((item) => item.id))).toEqual([
      ['a'],
      ['big'],
      ['b'],
    ]);
    expect(planFetchChunks([], 100)).toEqual([]);
  });
});

describe('featureJson', () => {
  it('splices the PostGIS geometry text into a valid Feature', () => {
    expect(JSON.parse(featureJson(ROW))).toEqual({
      type: 'Feature',
      id: ROW.id,
      geometry: {
        type: 'LineString',
        coordinates: [
          [112.6, -7.1],
          [112.7, -7.2],
        ],
      },
      properties: {
        id: ROW.id,
        orgId: null,
        global: true,
        code: 'mvp-pipeline',
        name: 'Pipeline "A"',
        kind: 'pipeline',
        bufferM: 1750,
        alertOnEnter: false,
        active: true,
        updatedAt: '2026-01-01T00:00:00.000Z',
        zoneProperties: { note: 'MVP', source: 'legacy' },
      },
    });
  });
});

describe('featureCollectionJson', () => {
  it('streams a FeatureCollection with the budget members after the features', async () => {
    const text = await collect(
      featureCollectionJson(
        eventsOf(
          { kind: 'feature', feature: ROW },
          { kind: 'feature', feature: { ...ROW, id: 'second' } },
          { kind: 'end', summary: SUMMARY },
        ),
      ),
    );
    const collection = JSON.parse(text) as Record<string, unknown> & {
      features: { id: string }[];
    };
    expect(collection.features.map((feature) => feature.id)).toEqual([
      ROW.id,
      'second',
    ]);
    expect(collection).toMatchObject({
      type: 'FeatureCollection',
      truncated: true,
      truncatedBy: 'vertices',
      limit: 10,
      vertexLimit: 3,
      featureCount: 1,
      vertexCount: 2,
      zoom: 9,
      toleranceDeg: SUMMARY.toleranceDeg,
    });
  });

  it('writes an empty collection, and fails when the summary is missing', async () => {
    const empty = JSON.parse(
      await collect(
        featureCollectionJson(
          eventsOf({
            kind: 'end',
            summary: {
              ...SUMMARY,
              truncated: false,
              truncatedBy: null,
              featureCount: 0,
              vertexCount: 0,
              zoom: null,
              toleranceDeg: 0,
            },
          }),
        ),
      ),
    ) as Record<string, unknown>;
    expect(empty).toMatchObject({
      features: [],
      truncated: false,
      truncatedBy: null,
      zoom: null,
    });
    await expect(
      collect(
        featureCollectionJson(eventsOf({ kind: 'feature', feature: ROW })),
      ),
    ).rejects.toThrow(/without a summary/);
  });
});
