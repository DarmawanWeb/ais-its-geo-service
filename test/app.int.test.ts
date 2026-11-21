import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from '../src/service.js';
import { startTestService, type TestService } from './support/test-service.js';

// Under /api/v2/zones: the gateway routes only that prefix to geo (spec §12).
const METHODOLOGY_URL = '/api/v2/zones/methodology';

describe(`${SERVICE.packageName} platform behaviour`, () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('is live and ready with the database and NATS up', async () => {
    const live = await service.app.inject({
      method: 'GET',
      url: '/health/live',
    });
    expect(live.statusCode).toBe(200);

    const ready = await service.app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      details: { database: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('applied the migrations to its own schema', async () => {
    const { rows } = await service.pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((row) => row.name)).toContain('init');
    const tables = await service.pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = $1 ORDER BY table_name`,
      [SERVICE.schema],
    );
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['outbox', 'zones', 'zones_tiles']),
    );
  });

  it('denies anonymous requests with 401 problem details', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: METHODOLOGY_URL,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['www-authenticate']).toBeDefined();
  });

  it('serves the methodology to a signed-in user', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: METHODOLOGY_URL,
      headers: await service.authorization({ roles: ['viewer'] }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: SERVICE.name,
      methods: [
        { id: 'data.pipeline_route', catalogued: true, needsCitation: true },
        { id: 'data.batam_area', catalogued: true, needsCitation: true },
      ],
    });
  });

  it('documents its routes in /openapi.json', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: '/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        METHODOLOGY_URL,
        '/api/v2/zones',
        '/api/v2/zones/{id}',
        '/api/v2/zones/geojson',
        '/api/v2/zones/republish',
      ]),
    );
  });

  it('exposes Prometheus metrics', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('aisits_http_requests_total');
    expect(response.body).toContain('aisits_outbox_pending');
  });
});
