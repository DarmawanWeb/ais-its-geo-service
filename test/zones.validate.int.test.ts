import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BATAM_SQUARE, BOW_TIE, zoneBody } from './support/fixtures.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';
const VALIDATE = `${ZONES}/validate`;

interface Validation {
  valid: boolean;
  problem: Record<string, unknown> | null;
  geometryType: string | null;
  vertexCount: number | null;
  bbox: number[] | null;
}

/** A problem without the members that describe the request (path, ids). */
function withoutRequestMembers(
  problem: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const {
    instance: _instance,
    traceId: _traceId,
    requestId: _requestId,
    ...rest
  } = problem ?? {};
  return rest;
}

/**
 * `POST /api/v2/zones/validate`: the input rules of a create (README steps
 * 2-8, PostGIS ST_IsValidDetail included) as a dry run for the zone editor.
 */
describe('zone draft validation (dry run)', () => {
  let service: TestService;

  async function stored(): Promise<{ zones: number; outbox: number }> {
    const { rows } = await service.pool.query<{
      zones: string;
      outbox: string;
    }>(
      'SELECT (SELECT count(*) FROM zones) AS zones, (SELECT count(*) FROM outbox) AS outbox',
    );
    return { zones: Number(rows[0]?.zones), outbox: Number(rows[0]?.outbox) };
  }

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('accepts a valid draft with the facts of its geometry and stores nothing', async () => {
    const before = await stored();
    const response = await service.request('POST', VALIDATE, {
      user: USERS.orgAdminA,
      body: { kind: 'restricted', geometry: BATAM_SQUARE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Validation>()).toEqual({
      valid: true,
      problem: null,
      geometryType: 'Polygon',
      vertexCount: 5,
      bbox: [104, 1.1, 104.1, 1.2],
    });
    expect(await stored()).toEqual(before);
  });

  it('reports a self-intersection with its location, as the create answers it', async () => {
    const before = await stored();
    const dryRun = await service.request('POST', VALIDATE, {
      user: USERS.orgAdminA,
      body: { kind: 'restricted', geometry: BOW_TIE },
    });
    expect(dryRun.statusCode).toBe(200);
    const validation = dryRun.json<Validation>();
    expect(validation).toMatchObject({
      valid: false,
      geometryType: 'Polygon',
      vertexCount: 5,
      problem: {
        type: 'urn:ais-its:problem:zone-geometry-invalid',
        status: 422,
        code: 'ZONE_GEOMETRY_INVALID',
        reason: expect.stringMatching(/self-intersection/i) as string,
        location: [expect.any(Number), expect.any(Number)] as number[],
        instance: VALIDATE,
      },
    });
    const location = validation.problem?.location as number[];
    expect(location[0]).toBeCloseTo(104.05, 6);
    expect(location[1]).toBeCloseTo(1.05, 6);
    expect(await stored()).toEqual(before);

    const write = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ geometry: BOW_TIE }),
    });
    expect(write.statusCode).toBe(422);
    expect(withoutRequestMembers(validation.problem)).toEqual(
      withoutRequestMembers(write.json()),
    );
  });

  it('reports structure, kind, buffer and antimeridian problems inside a 200', async () => {
    const check = async (body: Record<string, unknown>) => {
      const response = await service.request('POST', VALIDATE, {
        user: USERS.authority,
        body,
      });
      expect(response.statusCode).toBe(200);
      return response.json<Validation>();
    };

    const unclosed = await check({
      kind: 'restricted',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [104, 1],
            [104.1, 1],
            [104.1, 1.1],
            [104, 1.1],
          ],
        ],
      },
    });
    expect(unclosed).toMatchObject({
      valid: false,
      geometryType: null,
      vertexCount: null,
      bbox: null,
      problem: { status: 400, code: 'VALIDATION_FAILED' },
    });
    expect((unclosed.problem?.errors as { field: string }[])[0]?.field).toMatch(
      /^geometry\.coordinates/,
    );

    expect(
      await check({
        kind: 'pipeline',
        geometry: BATAM_SQUARE,
      }),
    ).toMatchObject({
      valid: false,
      geometryType: 'Polygon',
      problem: {
        status: 422,
        code: 'ZONE_GEOMETRY_TYPE_NOT_ALLOWED',
        allowedGeometryTypes: ['LineString', 'MultiLineString'],
      },
    });
    const point = { type: 'Point', coordinates: [104.02, 1.17] };
    expect(await check({ kind: 'anchorage', geometry: point })).toMatchObject({
      valid: false,
      problem: { code: 'ZONE_BUFFER_REQUIRED' },
    });
    expect(
      await check({ kind: 'anchorage', geometry: point, bufferM: 500 }),
    ).toMatchObject({ valid: true, geometryType: 'Point', vertexCount: 1 });
    expect(
      await check({
        kind: 'mpa',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [179, 0],
              [-179, 0],
              [-179, 1],
              [179, 1],
              [179, 0],
            ],
          ],
        },
      }),
    ).toMatchObject({
      valid: false,
      problem: { code: 'ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN' },
    });
    expect(
      await check({
        kind: 'restricted',
        geometry: BATAM_SQUARE,
        properties: { source: 'reserved' },
      }),
    ).toMatchObject({
      valid: false,
      problem: {
        status: 400,
        errors: [expect.objectContaining({ field: 'properties.source' })],
      },
    });
  });

  it('answers 400 for a malformed request and needs zone:write', async () => {
    const malformed = await service.request('POST', VALIDATE, {
      user: USERS.orgAdminA,
      body: { bufferM: -1 },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      new Set(
        malformed
          .json<{ errors: { field: string }[] }>()
          .errors.map((error) => error.field),
      ),
    ).toEqual(new Set(['kind', 'geometry', 'bufferM']));

    const body = { kind: 'restricted', geometry: BATAM_SQUARE };
    const viewer = await service.request('POST', VALIDATE, {
      user: USERS.viewerA,
      body,
    });
    expect(viewer.statusCode).toBe(403);
    const anonymous = await service.request('POST', VALIDATE, { body });
    expect(anonymous.statusCode).toBe(401);
  });
});
