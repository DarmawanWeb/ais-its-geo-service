import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BATAM_SQUARE,
  BOW_TIE,
  idOf,
  SURABAYA_SQUARE,
  zoneBody,
  zoneCode,
} from './support/fixtures.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';

interface Problem {
  code: string;
  status: number;
  detail?: string;
  errors?: { field: string; message: string }[];
  [extra: string]: unknown;
}

describe('zones CRUD and input validation', () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
    await service.reset();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('creates, reads, updates and deletes an organization zone', async () => {
    const body = zoneBody({
      kind: 'anchorage',
      geometry: { type: 'Point', coordinates: [104.05, 1.15] },
      bufferM: 500,
      properties: { unlocode: 'IDBTM', note: 'Anchorage A' },
      source: 'KSOP Batam notice',
    });
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body,
    });
    expect(created.statusCode).toBe(201);
    const zone = created.json();
    expect(zone).toMatchObject({
      orgId: USERS.orgAdminA.orgId,
      global: false,
      code: body.code,
      kind: 'anchorage',
      geometry: { type: 'Point', coordinates: [104.05, 1.15] },
      bufferM: 500,
      alertOnEnter: false,
      active: true,
      properties: { unlocode: 'IDBTM', note: 'Anchorage A' },
      source: 'KSOP Batam notice',
      geometryType: 'Point',
      vertexCount: 1,
      bbox: [104.05, 1.15, 104.05, 1.15],
    });
    const id = idOf(created);

    const read = await service.request('GET', `${ZONES}/${id}`, {
      user: USERS.viewerA,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(zone);

    const updated = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { name: 'Anchorage A (west)', bufferM: 750, source: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: 'Anchorage A (west)',
      bufferM: 750,
      source: null,
    });
    expect(
      Date.parse(updated.json<{ updatedAt: string }>().updatedAt),
    ).toBeGreaterThan(Date.parse(zone.updatedAt as string));

    const deleted = await service.request('DELETE', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
    });
    expect(deleted.statusCode).toBe(204);
    const gone = await service.request('GET', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<Problem>()).toMatchObject({ code: 'ZONE_NOT_FOUND' });
  });

  it('drops altitudes and stores the geometry as 2-D', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        kind: 'pipeline',
        geometry: {
          type: 'LineString',
          coordinates: [
            [112.7, -6.9, 0],
            [112.71, -6.95, -12.5],
          ],
        },
      }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      geometry: {
        type: 'LineString',
        coordinates: [
          [112.7, -6.9],
          [112.71, -6.95],
        ],
      },
    });
  });

  it('refuses malformed GeoJSON with field errors (400)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [104, 1],
              [104.1, 1],
              [104.1, 1.1],
            ],
          ],
        },
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const problem = response.json<Problem>();
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.length).toBeGreaterThan(0);
    expect(new Set(problem.errors?.map((error) => error.field))).toEqual(
      new Set(['geometry.coordinates.0']),
    );
  });

  it('refuses coordinates outside WGS84 with a [lon, lat] hint (400)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        kind: 'port',
        bufferM: 100,
        geometry: { type: 'Point', coordinates: [-7.1, 112.6] },
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<Problem>().errors).toEqual([
      expect.objectContaining({
        field: 'geometry.coordinates.1',
        message: expect.stringContaining('[longitude, latitude]') as string,
      }),
    ]);
  });

  it('refuses a self-intersecting polygon with the reason and location (422)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ geometry: BOW_TIE }),
    });
    expect(response.statusCode).toBe(422);
    const problem = response.json<Problem>();
    expect(problem).toMatchObject({
      code: 'ZONE_GEOMETRY_INVALID',
      reason: 'Self-intersection',
    });
    const [lon, lat] = problem.location as [number, number];
    expect(lon).toBeCloseTo(104.05, 9);
    expect(lat).toBeCloseTo(1.05, 9);
    expect(problem.detail).toContain('at or near [104.050000, 1.050000]');
    expect(problem.detail).toContain('not repaired automatically');
  });

  it('refuses a geometry type the kind does not allow (422)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ kind: 'pipeline', geometry: SURABAYA_SQUARE }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>()).toMatchObject({
      code: 'ZONE_GEOMETRY_TYPE_NOT_ALLOWED',
      kind: 'pipeline',
      geometryType: 'Polygon',
      allowedGeometryTypes: ['LineString', 'MultiLineString'],
    });
  });

  it('needs a buffer for point zones (422)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        kind: 'restricted',
        geometry: { type: 'Point', coordinates: [104, 1] },
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>().code).toBe('ZONE_BUFFER_REQUIRED');
  });

  it('refuses more than 50 000 vertices (422), large bodies are accepted', async () => {
    const coordinates = Array.from({ length: 50_001 }, (_, index) => [
      100 + index * 1e-5,
      1 + (index % 2) * 1e-5,
    ]);
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        kind: 'custom',
        geometry: { type: 'LineString', coordinates },
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>()).toMatchObject({
      code: 'ZONE_GEOMETRY_TOO_COMPLEX',
      vertices: 50_001,
      maxVertices: 50_000,
    });
  });

  it('versions zones with an ETag and refuses a stale If-Match (412)', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ properties: { note: 'base' } }),
    });
    expect(created.statusCode).toBe(201);
    const id = idOf(created);
    const version = created.headers.etag as string;
    expect(version).toBe(
      `"${created.json<{ updatedAt: string }>().updatedAt}"`,
    );
    const read = await service.request('GET', `${ZONES}/${id}`, {
      user: USERS.viewerA,
    });
    expect(read.headers.etag).toBe(version);

    // Editor A saves first, on the version both editors loaded.
    const first = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      headers: { 'if-match': version },
      body: { properties: { note: 'A' } },
    });
    expect(first.statusCode).toBe(200);
    const next = first.headers.etag as string;
    expect(next).not.toBe(version);

    // Editor B, still on the old version, is refused instead of overwriting A.
    const stale = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      headers: { 'if-match': version },
      body: { properties: { unlocode: 'IDBTM' } },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.headers['content-type']).toContain('application/problem+json');
    expect(stale.json<Problem>()).toMatchObject({
      code: 'ZONE_VERSION_CONFLICT',
      currentEtag: next,
    });
    const kept = await service.request('GET', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
    });
    expect(kept.json()).toMatchObject({ properties: { note: 'A' } });

    const malformed = await service.request('DELETE', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      headers: { 'if-match': 'not-a-tag' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<Problem>()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'If-Match' })],
    });
    const staleDelete = await service.request('DELETE', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      headers: { 'if-match': version },
    });
    expect(staleDelete.statusCode).toBe(412);
    const deleted = await service.request('DELETE', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      headers: { 'if-match': next },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('refuses a geometry crossing the antimeridian with a splitting hint (422)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
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
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>()).toMatchObject({
      code: 'ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN',
      path: 'geometry.coordinates.0.0',
      detail: expect.stringContaining('Split the geometry') as string,
    });
  });

  it('counts refused writes by problem code, DTO validation included', async () => {
    const invalidDto = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ code: 'Not A Slug' }),
    });
    expect(invalidDto.statusCode).toBe(400);
    const metrics = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metrics.body).toMatch(
      /aisits_geo_zone_rejections_total\{code="VALIDATION_FAILED"\} [1-9]/,
    );
    expect(metrics.body).toMatch(
      /aisits_geo_zone_rejections_total\{code="ZONE_GEOMETRY_INVALID"\} [1-9]/,
    );
  });

  it('refuses a duplicate code of the same owner (409)', async () => {
    const code = zoneCode('dup');
    const first = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ code }),
    });
    expect(first.statusCode).toBe(201);
    const second = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ code }),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<Problem>()).toMatchObject({
      code: 'ZONE_CODE_TAKEN',
      zoneCode: code,
    });
    // Another organization and the global namespace may reuse the code.
    const otherOrg = await service.request('POST', ZONES, {
      user: USERS.orgAdminB,
      body: zoneBody({ code }),
    });
    expect(otherOrg.statusCode).toBe(201);
    const global = await service.request('POST', ZONES, {
      user: USERS.superAdmin,
      body: zoneBody({ code, global: true }),
    });
    expect(global.statusCode).toBe(201);
  });

  it('validates kind properties and the DTO fields (400)', async () => {
    const properties = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({
        kind: 'pipeline',
        geometry: {
          type: 'LineString',
          coordinates: [
            [112.7, -6.9],
            [112.71, -6.95],
          ],
        },
        properties: { markers: [{ name: 'KP 1', lat: -95, lon: 112.7 }] },
      }),
    });
    expect(properties.statusCode).toBe(400);
    expect(properties.json<Problem>().errors).toEqual([
      expect.objectContaining({ field: 'properties.markers.0.lat' }),
    ]);

    const dto = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: { ...zoneBody({ code: 'Has Spaces', kind: 'lake' }), orgId: 'x' },
    });
    expect(dto.statusCode).toBe(400);
    expect(
      dto
        .json<Problem>()
        .errors?.map((error) => error.field)
        .sort(),
    ).toEqual(['code', 'kind', 'orgId']);
  });

  it('re-validates the geometry and the kind on PATCH', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ geometry: BATAM_SQUARE }),
    });
    const id = idOf(created);

    const invalid = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { geometry: BOW_TIE },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<Problem>().code).toBe('ZONE_GEOMETRY_INVALID');

    const wrongKind = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { kind: 'pipeline' },
    });
    expect(wrongKind.statusCode).toBe(422);
    expect(wrongKind.json<Problem>().code).toBe(
      'ZONE_GEOMETRY_TYPE_NOT_ALLOWED',
    );

    const moved = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { geometry: SURABAYA_SQUARE, kind: 'mpa', alertOnEnter: true },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      kind: 'mpa',
      alertOnEnter: true,
      geometry: SURABAYA_SQUARE,
      bbox: [112.6, -7.1, 112.7, -7],
    });

    const immutable = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { code: 'renamed' },
    });
    expect(immutable.statusCode).toBe(400);

    // null is a value only for `source` (clears it); NOT NULL columns refuse it.
    const nulls = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { name: null, bufferM: null, active: null, properties: null },
    });
    expect(nulls.statusCode).toBe(400);
    expect(nulls.json<Problem>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    // One field error per failed constraint (bufferM: isNumber, min, max).
    const fields = new Set(
      nulls.json<Problem>().errors?.map((error) => error.field),
    );
    expect([...fields].sort()).toEqual([
      'active',
      'bufferM',
      'name',
      'properties',
    ]);
    const sourced = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { source: 'Harbour master survey 2026' },
    });
    expect(sourced.json()).toMatchObject({
      source: 'Harbour master survey 2026',
    });
    const cleared = await service.request('PATCH', `${ZONES}/${id}`, {
      user: USERS.orgAdminA,
      body: { source: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      source: null,
      name: moved.json<{ name: string }>().name,
    });
  });

  it('requires a token and the zone permissions (401/403)', async () => {
    const anonymous = await service.request('GET', ZONES);
    expect(anonymous.statusCode).toBe(401);

    const viewer = await service.request('POST', ZONES, {
      user: USERS.viewerA,
      body: zoneBody(),
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json<Problem>().code).toBe('FORBIDDEN');

    const fleetManager = await service.request('POST', ZONES, {
      user: USERS.fleetManagerA,
      body: zoneBody(),
    });
    expect(fleetManager.statusCode).toBe(403);
  });

  it('answers 404 for unknown ids and 400 for malformed ones', async () => {
    const unknown = await service.request(
      'GET',
      `${ZONES}/019a0000-0000-7000-8000-000000000000`,
      { user: USERS.superAdmin },
    );
    expect(unknown.statusCode).toBe(404);
    const malformed = await service.request('GET', `${ZONES}/not-a-uuid`, {
      user: USERS.superAdmin,
    });
    expect(malformed.statusCode).toBe(400);
    // The kit's @UuidParam(): a field error on the path parameter.
    expect(malformed.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'id', code: 'isUuid' })],
    });
  });
});
