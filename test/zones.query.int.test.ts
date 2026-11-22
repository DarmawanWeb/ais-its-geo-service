import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idOf, square, zoneBody } from './support/fixtures.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';

interface FeatureCollection {
  type: string;
  truncated: boolean;
  truncatedBy: 'features' | 'vertices' | null;
  limit: number;
  vertexLimit: number;
  featureCount: number;
  vertexCount: number;
  zoom: number | null;
  toleranceDeg: number;
  features: {
    type: string;
    id: string;
    geometry: { type: string; coordinates: number[][][] };
    properties: Record<string, unknown>;
  }[];
}

/** List and map queries: kind, active, bbox, search, pages, FeatureCollection. */
describe('zone queries', () => {
  let service: TestService;
  const ids: Record<string, string> = {};

  async function listCodes(query: string): Promise<string[]> {
    const response = await service.request('GET', `${ZONES}?${query}`, {
      user: USERS.superAdmin,
    });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ data: { code: string }[] }>()
      .data.map((zone) => zone.code)
      .sort();
  }

  beforeAll(async () => {
    service = await startTestService({
      ZONES_GEOJSON_MAX_FEATURES: '3',
      ZONES_GEOJSON_MAX_VERTICES: '50000',
    });
    await service.reset();
    const zones = [
      // Singapore Strait / Batam
      {
        code: 'q-batam-anchorage',
        kind: 'anchorage',
        geometry: square(104.0, 1.1),
      },
      {
        code: 'q-batam-restricted',
        kind: 'restricted',
        geometry: square(103.8, 1.0, 0.05),
      },
      // Gresik / Surabaya
      {
        code: 'q-gresik-pipeline',
        kind: 'pipeline',
        geometry: {
          type: 'LineString',
          coordinates: [
            [112.7193848, -6.8719722],
            [112.6568908, -7.1438932],
          ],
        },
        bufferM: 1750,
      },
      {
        code: 'q-surabaya-port',
        kind: 'port',
        geometry: square(112.7, -7.2, 0.05),
        active: false,
      },
      // Crosses the edge of the Batam bbox below (lon 104.45–104.55).
      { code: 'q-edge-mpa', kind: 'mpa', geometry: square(104.45, 1.0) },
    ];
    for (const zone of zones) {
      const response = await service.request('POST', ZONES, {
        user: USERS.superAdmin,
        body: zoneBody({ ...zone, global: true, name: `Zone ${zone.code}` }),
      });
      expect(response.statusCode).toBe(201);
      ids[zone.code] = idOf(response);
    }
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('filters by bbox in lon/lat space, edge-crossing zones included', async () => {
    expect(await listCodes('bbox=103.5,0.8,104.5,1.5')).toEqual([
      'q-batam-anchorage',
      'q-batam-restricted',
      'q-edge-mpa',
    ]);
    expect(await listCodes('bbox=112.5,-7.5,113,-6.5')).toEqual([
      'q-gresik-pipeline',
      'q-surabaya-port',
    ]);
    expect(await listCodes('bbox=0,0,1,1')).toEqual([]);
  });

  it('matches zones whose buffer reaches the bbox, the centre outside', async () => {
    // A restricted circle of 50 km around [106, 3]: the viewport's corner
    // (106.2, 3.1) is 24.8 km from the centre.
    const circle = await service.request('POST', ZONES, {
      user: USERS.superAdmin,
      body: zoneBody({
        code: 'q-circle',
        kind: 'restricted',
        geometry: { type: 'Point', coordinates: [106, 3] },
        bufferM: 50_000,
        global: true,
      }),
    });
    expect(circle.statusCode).toBe(201);
    try {
      expect(await listCodes('bbox=106.2,3.0,106.5,3.2')).toEqual(['q-circle']);
      const map = await service.request(
        'GET',
        `${ZONES}/geojson?bbox=106.2,3.0,106.5,3.2`,
        { user: USERS.viewerA },
      );
      expect(
        map.json<FeatureCollection>().features.map((feature) => feature.id),
      ).toEqual([idOf(circle)]);
      // Inside the circle's bounding box but 62.8 km from the centre, and
      // beyond the box: not matched.
      expect(await listCodes('bbox=106.4,3.4,106.6,3.6')).toEqual([]);
      expect(await listCodes('bbox=106.5,3.5,107,4')).toEqual([]);
      // The pipeline corridor (1 750 m) reaches a box 1 km east of the line.
      expect(await listCodes('bbox=112.73,-6.88,112.74,-6.87')).toEqual([
        'q-gresik-pipeline',
      ]);
    } finally {
      await service.request('DELETE', `${ZONES}/${idOf(circle)}`, {
        user: USERS.superAdmin,
      });
    }
  });

  it('refuses a malformed bbox (400)', async () => {
    const response = await service.request('GET', `${ZONES}?bbox=104,1,105`, {
      user: USERS.superAdmin,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('filters by kinds (repeated or comma separated), active and search', async () => {
    expect(await listCodes('kind=pipeline,port')).toEqual([
      'q-gresik-pipeline',
      'q-surabaya-port',
    ]);
    expect(await listCodes('kind=mpa&kind=anchorage')).toEqual([
      'q-batam-anchorage',
      'q-edge-mpa',
    ]);
    expect(await listCodes('active=false')).toEqual(['q-surabaya-port']);
    expect(await listCodes('search=BATAM')).toEqual([
      'q-batam-anchorage',
      'q-batam-restricted',
    ]);
    expect(await listCodes('search=%25')).toEqual([]);
  });

  it('pages the summaries without geometries', async () => {
    const response = await service.request(
      'GET',
      `${ZONES}?page=2&pageSize=2`,
      {
        user: USERS.superAdmin,
      },
    );
    const page = response.json<{
      data: Record<string, unknown>[];
      meta: { page: number; pageSize: number; total: number };
    }>();
    expect(page.meta).toEqual({ page: 2, pageSize: 2, total: 5 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0]).not.toHaveProperty('geometry');
    expect(page.data[0]).toMatchObject({
      geometryType: expect.any(String) as string,
      vertexCount: expect.any(Number) as number,
      bbox: expect.any(Array) as number[],
    });
  });

  it('serves the map layer as a GeoJSON FeatureCollection (active zones)', async () => {
    const response = await service.request(
      'GET',
      `${ZONES}/geojson?bbox=103.5,0.8,104.5,1.5`,
      { user: USERS.viewerA },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/geo+json');
    const collection = response.json<FeatureCollection>();
    expect(collection).toMatchObject({
      type: 'FeatureCollection',
      truncated: false,
      truncatedBy: null,
      limit: 3,
      vertexLimit: 50_000,
      featureCount: 3,
      vertexCount: 15,
      zoom: null,
      toleranceDeg: 0,
    });
    expect(collection.features.map((feature) => feature.id).sort()).toEqual(
      [
        ids['q-batam-anchorage'],
        ids['q-batam-restricted'],
        ids['q-edge-mpa'],
      ].sort(),
    );
    const anchorage = collection.features.find(
      (feature) => feature.id === ids['q-batam-anchorage'],
    );
    expect(anchorage).toMatchObject({
      type: 'Feature',
      geometry: square(104.0, 1.1),
      properties: {
        id: ids['q-batam-anchorage'],
        code: 'q-batam-anchorage',
        kind: 'anchorage',
        global: true,
        active: true,
        zoneProperties: {},
      },
    });
  });

  it('rounds map coordinates to 6 decimals and caps the features', async () => {
    const pipeline = await service.request(
      'GET',
      `${ZONES}/geojson?kind=pipeline`,
      { user: USERS.viewerA },
    );
    expect(
      pipeline.json<FeatureCollection>().features[0]?.geometry.coordinates,
    ).toEqual([
      [112.719385, -6.871972],
      [112.656891, -7.143893],
    ]);

    const all = await service.request('GET', `${ZONES}/geojson`, {
      user: USERS.viewerA,
    });
    // 4 active zones, ZONES_GEOJSON_MAX_FEATURES = 3.
    expect(all.json<FeatureCollection>()).toMatchObject({
      truncated: true,
      truncatedBy: 'features',
      limit: 3,
    });
    expect(all.json<FeatureCollection>().features).toHaveLength(3);

    const inactive = await service.request(
      'GET',
      `${ZONES}/geojson?active=false`,
      { user: USERS.viewerA },
    );
    expect(
      inactive.json<FeatureCollection>().features.map((feature) => feature.id),
    ).toEqual([ids['q-surabaya-port']]);
  });

  it('bounds the map by vertices and simplifies the geometries for the zoom', async () => {
    // Two pipelines of 30 000 vertices (a zig-zag of 1e-5 degrees) and the
    // 2-vertex Gresik pipeline; ZONES_GEOJSON_MAX_VERTICES = 50 000.
    const created: string[] = [];
    for (const [index, lat] of [0.5, 0.6].entries()) {
      const response = await service.request('POST', ZONES, {
        user: USERS.superAdmin,
        body: zoneBody({
          code: `q-detailed-${String(index)}`,
          name: `Zone q-detailed-${String(index)}`,
          kind: 'pipeline',
          global: true,
          geometry: {
            type: 'LineString',
            coordinates: Array.from({ length: 30_000 }, (_, vertex) => [
              Number((100 + vertex * 1e-5).toFixed(5)),
              lat + (vertex % 2) * 1e-5,
            ]),
          },
        }),
      });
      expect(response.statusCode).toBe(201);
      created.push(idOf(response));
    }
    try {
      const full = await service.request(
        'GET',
        `${ZONES}/geojson?kind=pipeline`,
        { user: USERS.authority },
      );
      expect(full.statusCode).toBe(200);
      // Layer order (kind, name): Zone q-detailed-0, Zone q-detailed-1, Zone q-gresik-pipeline.
      expect(full.json<FeatureCollection>()).toMatchObject({
        truncated: true,
        truncatedBy: 'vertices',
        featureCount: 1,
        vertexCount: 30_000,
        vertexLimit: 50_000,
      });
      expect(
        full.json<FeatureCollection>().features.map((feature) => feature.id),
      ).toEqual([created[0]]);

      const zoomed = await service.request(
        'GET',
        `${ZONES}/geojson?kind=pipeline&zoom=5`,
        { user: USERS.authority },
      );
      const collection = zoomed.json<FeatureCollection>();
      expect(collection).toMatchObject({
        truncated: false,
        truncatedBy: null,
        featureCount: 3,
        zoom: 5,
      });
      expect(collection.toleranceDeg).toBeCloseTo(0.3515625 / 32, 12);
      // The 1e-5 degree zig-zag is far below half a pixel at zoom 5.
      expect(collection.vertexCount).toBeLessThan(20);
      expect(
        collection.features.map(
          (feature) => feature.geometry.coordinates.length,
        ),
      ).toEqual([2, 2, 2]);

      const invalid = await service.request('GET', `${ZONES}/geojson?zoom=25`, {
        user: USERS.authority,
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      for (const id of created) {
        await service.request('DELETE', `${ZONES}/${id}`, {
          user: USERS.superAdmin,
        });
      }
    }
  });
});
