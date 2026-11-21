import { fileURLToPath } from 'node:url';

import {
  createDatabasePool,
  type Pool,
  runMigrations,
} from '@darmawanweb/ais-its-nest/db';
import {
  provisionServiceSchema,
  uniqueName,
} from '@darmawanweb/ais-its-nest/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies the service migrations to a fresh schema; returns its pool. */
async function migratedSchema(adminUrl: string, schema: string): Promise<Pool> {
  const url = await provisionServiceSchema(adminUrl, schema);
  const pool = createDatabasePool({
    connectionString: url,
    schema,
    max: 2,
    statementTimeoutMs: 30_000,
    applicationName: 'geo-tiles-test',
  });
  await runMigrations({ pool, schema, dir: MIGRATIONS });
  return pool;
}

/** `zones_tiles` for Martin (spec §6): granted to tiles_ro when the role exists. */
describe('zones_tiles view', () => {
  const { adminUrl } = inject('infra');
  const admin = new pg.Client({ connectionString: adminUrl });
  const pools: Pool[] = [];

  async function roleExists(): Promise<boolean> {
    const { rows } = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_ro') AS exists",
    );
    return rows[0]?.exists === true;
  }

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.end();
  });

  it('migrates without tiles_ro (no grant attempted)', async () => {
    if (await roleExists()) return; // created by an earlier run of this file
    const schema = uniqueName('geo_notiles');
    pools.push(await migratedSchema(adminUrl, schema));
    const { rows } = await admin.query<{ views: string }>(
      `SELECT count(*) AS views FROM pg_views WHERE schemaname = $1 AND viewname = 'zones_tiles'`,
      [schema],
    );
    expect(rows[0]?.views).toBe('1');
  });

  it('grants SELECT on the view (only) to tiles_ro, which sees global active zones only', async () => {
    if (!(await roleExists())) {
      await admin.query(
        "CREATE ROLE tiles_ro LOGIN NOINHERIT PASSWORD 'tiles_ro'",
      );
    }
    await admin.query(
      'GRANT CONNECT ON DATABASE ' +
        pg.escapeIdentifier(
          (await admin.query<{ db: string }>('SELECT current_database() AS db'))
            .rows[0]?.db ?? '',
        ) +
        ' TO tiles_ro',
    );
    const schema = uniqueName('geo_tiles');
    const pool = await migratedSchema(adminUrl, schema);
    pools.push(pool);

    const privileges = await admin.query<{
      view: boolean;
      table: boolean;
      usage: boolean;
    }>(
      `SELECT has_table_privilege('tiles_ro', $1, 'SELECT') AS view,
              has_table_privilege('tiles_ro', $2, 'SELECT') AS table,
              has_schema_privilege('tiles_ro', $3, 'USAGE') AS usage`,
      [`${schema}.zones_tiles`, `${schema}.zones`, schema],
    );
    expect(privileges.rows[0]).toEqual({ view: true, table: false, usage: true });

    // Martin discovers the view through geometry_columns (SRID 4326).
    const columns = await admin.query<{ srid: number; type: string }>(
      `SELECT srid, type FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = 'zones_tiles'`,
      [schema],
    );
    expect(columns.rows).toEqual([{ srid: 4326, type: 'GEOMETRY' }]);

    const square = `ST_GeomFromText('POLYGON((104 1, 104.1 1, 104.1 1.1, 104 1.1, 104 1))', 4326)::geography`;
    await pool.query(
      `INSERT INTO zones (id, org_id, code, name, kind, geom, active) VALUES
         (gen_random_uuid(), NULL, 'global-active', 'Global active', 'restricted', ${square}, true),
         (gen_random_uuid(), NULL, 'global-inactive', 'Global inactive', 'restricted', ${square}, false),
         (gen_random_uuid(), gen_random_uuid(), 'org-zone', 'Org zone', 'restricted', ${square}, true)`,
    );

    const url = new URL(adminUrl);
    url.username = 'tiles_ro';
    url.password = 'tiles_ro';
    const tiles = new pg.Client({ connectionString: url.toString() });
    await tiles.connect();
    try {
      const visible = await tiles.query<{ code: string; srid: number }>(
        `SELECT code, ST_SRID(geom) AS srid FROM ${pg.escapeIdentifier(schema)}.zones_tiles ORDER BY code`,
      );
      expect(visible.rows).toEqual([{ code: 'global-active', srid: 4326 }]);
      await expect(
        tiles.query(`SELECT code FROM ${pg.escapeIdentifier(schema)}.zones`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await tiles.end();
    }
  });
});
