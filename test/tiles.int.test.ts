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

import { ensureTilesGrants } from '../src/modules/tiles/tiles-grants.js';

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

/** Tile x/y of a lon/lat at a zoom (slippy-map scheme). */
function tileOf(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const radians = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
        2) *
        n,
    ),
  ];
}

/**
 * The Martin sources (spec §6): the `zones_tiles` view and the index-backed
 * `zones_tiles_mvt` function, granted to tiles_ro when the role exists.
 */
describe('zones_tiles view and zones_tiles_mvt function', () => {
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
    expect(privileges.rows[0]).toEqual({
      view: true,
      table: false,
      usage: true,
    });
    // The function source: EXECUTE for tiles_ro only (revoked from PUBLIC).
    await admin.query(
      'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $r$geo_tiles_other$r$) THEN CREATE ROLE geo_tiles_other NOLOGIN; END IF; END $$',
    );
    const execute = await admin.query<{ tiles: boolean; other: boolean }>(
      `SELECT has_function_privilege('tiles_ro', $1, 'EXECUTE') AS tiles,
              has_function_privilege('geo_tiles_other', $1, 'EXECUTE') AS other`,
      [`${schema}.zones_tiles_mvt(integer, integer, integer)`],
    );
    expect(execute.rows[0]).toEqual({ tiles: true, other: false });

    // Martin discovers the view through geometry_columns (SRID 4326).
    const columns = await admin.query<{ srid: number; type: string }>(
      `SELECT srid, type FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = 'zones_tiles'`,
      [schema],
    );
    expect(columns.rows).toEqual([{ srid: 4326, type: 'GEOMETRY' }]);

    const square = `ST_GeomFromText('POLYGON((104 1, 104.1 1, 104.1 1.1, 104 1.1, 104 1))', 4326)::geography`;
    // Off Surabaya: organization and inactive zones only.
    const elsewhere = `ST_GeomFromText('POLYGON((112.6 -7.1, 112.7 -7.1, 112.7 -7.0, 112.6 -7.0, 112.6 -7.1))', 4326)::geography`;
    await pool.query(
      `INSERT INTO zones (id, org_id, code, name, kind, geom, active) VALUES
         (gen_random_uuid(), NULL, 'global-active', 'Global active', 'restricted', ${square}, true),
         (gen_random_uuid(), NULL, 'global-inactive', 'Global inactive', 'restricted', ${square}, false),
         (gen_random_uuid(), gen_random_uuid(), 'org-zone', 'Org zone', 'restricted', ${square}, true),
         (gen_random_uuid(), gen_random_uuid(), 'org-surabaya', 'Org zone', 'restricted', ${elsewhere}, true),
         (gen_random_uuid(), NULL, 'inactive-surabaya', 'Inactive', 'restricted', ${elsewhere}, false)`,
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

      // The function source, as Martin calls it: global active zones only,
      // read through a GiST index on the geometry (impossible through the
      // security-barrier view).
      const indexScans = async (): Promise<number> => {
        await admin.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await admin.query<{ scans: string }>(
          `SELECT coalesce(sum(idx_scan), 0) AS scans FROM pg_stat_user_indexes
            WHERE schemaname = $1
              AND indexrelname IN ('zones_tiles_geom_gist', 'zones_geom_gist')`,
          [schema],
        );
        return Number(rows[0]?.scans ?? 0);
      };
      const before = await indexScans();
      await tiles.query('SET enable_seqscan = off');
      const tile = async (lon: number, lat: number): Promise<Buffer> => {
        const [x, y] = tileOf(lon, lat, 10);
        const { rows } = await tiles.query<{ mvt: Buffer }>(
          `SELECT ${pg.escapeIdentifier(schema)}.zones_tiles_mvt(10, $1, $2) AS mvt`,
          [x, y],
        );
        return rows[0]?.mvt ?? Buffer.alloc(0);
      };
      const batam = await tile(104.05, 1.05);
      expect(batam.includes('zones_tiles_mvt')).toBe(true);
      expect(batam.includes('global-active')).toBe(true);
      expect(batam.includes('global-inactive')).toBe(false);
      expect(batam.includes('org-zone')).toBe(false);
      expect((await tile(112.65, -7.05)).length).toBe(0);
      await tiles.query('SELECT pg_stat_force_next_flush()');
      await tiles.query('SELECT 1');
      expect(await indexScans()).toBeGreaterThan(before);
    } finally {
      await tiles.end();
    }
  });

  it('re-applies missing tiles_ro grants at startup (role created after the migrations)', async () => {
    // A schema migrated while tiles_ro existed, whose grants are then lost
    // (same state as a role created after the migrations ran).
    const schema = uniqueName('geo_regrant');
    const pool = await migratedSchema(adminUrl, schema);
    pools.push(pool);
    const quoted = pg.escapeIdentifier(schema);
    await admin.query(`REVOKE USAGE ON SCHEMA ${quoted} FROM tiles_ro`);
    await admin.query(`REVOKE SELECT ON ${quoted}.zones_tiles FROM tiles_ro`);
    await admin.query(
      `REVOKE EXECUTE ON FUNCTION ${quoted}.zones_tiles_mvt(integer, integer, integer) FROM tiles_ro`,
    );

    const outcome = await ensureTilesGrants(pool);
    expect(outcome.roleExists).toBe(true);
    expect(outcome.granted).toHaveLength(3);
    const { rows } = await admin.query<{
      usage: boolean;
      view: boolean;
      fn: boolean;
    }>(
      `SELECT has_schema_privilege('tiles_ro', $1, 'USAGE') AS usage,
              has_table_privilege('tiles_ro', $2, 'SELECT') AS view,
              has_function_privilege('tiles_ro', $3, 'EXECUTE') AS fn`,
      [
        schema,
        `${schema}.zones_tiles`,
        `${schema}.zones_tiles_mvt(integer, integer, integer)`,
      ],
    );
    expect(rows[0]).toEqual({ usage: true, view: true, fn: true });
    // Idempotent: nothing left to grant.
    await expect(ensureTilesGrants(pool)).resolves.toEqual({
      roleExists: true,
      granted: [],
    });
  });
});
