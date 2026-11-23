import {
  InjectPool,
  type Pool,
  type PoolClient,
  sanitizeError,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

/** Role of Martin (spec §6), created by the infrastructure. */
export const TILES_ROLE = 'tiles_ro';

/**
 * What `tiles_ro` may do on the tiles sources of the service schema:
 * `true` granted, `false` missing, `null` the object does not exist (yet).
 */
export interface TilesPrivileges {
  readonly schemaUsage: boolean;
  readonly viewSelect: boolean | null;
  readonly functionExecute: boolean | null;
}

/**
 * The `GRANT` statements that give `tiles_ro` the missing privileges on the
 * tiles sources (`zones_tiles` view, `zones_tiles_mvt` function) of a schema.
 *
 * @param quotedSchema - the schema name, already quoted as an identifier.
 */
export function missingTilesGrants(
  privileges: TilesPrivileges,
  quotedSchema: string,
): string[] {
  const statements: string[] = [];
  if (!privileges.schemaUsage) {
    statements.push(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${TILES_ROLE}`);
  }
  if (privileges.viewSelect === false) {
    statements.push(
      `GRANT SELECT ON ${quotedSchema}.zones_tiles TO ${TILES_ROLE}`,
    );
  }
  if (privileges.functionExecute === false) {
    statements.push(
      `GRANT EXECUTE ON FUNCTION ${quotedSchema}.zones_tiles_mvt(integer, integer, integer) TO ${TILES_ROLE}`,
    );
  }
  return statements;
}

/** Outcome of {@link ensureTilesGrants}. */
export interface TilesGrantsOutcome {
  /** `false` when `tiles_ro` does not exist (nothing to grant). */
  readonly roleExists: boolean;
  /** The statements executed (empty when every privilege was there). */
  readonly granted: readonly string[];
}

async function tilesPrivileges(
  client: PoolClient,
): Promise<{ schema: string; privileges: TilesPrivileges }> {
  const { rows } = await client.query<{
    schema: string;
    schema_usage: boolean;
    view_select: boolean | null;
    function_execute: boolean | null;
  }>(
    `SELECT s.schema,
            has_schema_privilege($1, s.schema, 'USAGE') AS schema_usage,
            CASE WHEN s.view IS NULL THEN NULL
                 ELSE has_table_privilege($1, s.view, 'SELECT') END AS view_select,
            CASE WHEN s.fn IS NULL THEN NULL
                 ELSE has_function_privilege($1, s.fn, 'EXECUTE') END AS function_execute
       FROM (SELECT current_schema() AS schema,
                    to_regclass(format('%I.zones_tiles', current_schema()))::oid AS view,
                    to_regprocedure(format('%I.zones_tiles_mvt(integer, integer, integer)', current_schema()))::oid AS fn) AS s`,
    [TILES_ROLE],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Privilege query returned no row');
  return {
    schema: row.schema,
    privileges: {
      schemaUsage: row.schema_usage,
      viewSelect: row.view_select,
      functionExecute: row.function_execute,
    },
  };
}

/**
 * Grants `tiles_ro` what the migrations grant when the role exists, if it
 * is missing — e.g. because the infrastructure created the role after the
 * migrations ran (they grant only to an existing role). Idempotent; replicas
 * are serialized by a transaction-scoped advisory lock (concurrent `GRANT`s
 * on one object can fail with "tuple concurrently updated").
 */
export function ensureTilesGrants(pool: Pool): Promise<TilesGrantsOutcome> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [TILES_ROLE],
    );
    if (rows[0]?.exists !== true) return { roleExists: false, granted: [] };
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('geo.tiles_ro.grants', 0))",
    );
    const { schema, privileges } = await tilesPrivileges(client);
    const granted = missingTilesGrants(
      privileges,
      client.escapeIdentifier(schema),
    );
    for (const statement of granted) await client.query(statement);
    return { roleExists: true, granted };
  });
}

/**
 * Re-applies the `tiles_ro` grants of the tiles sources at every start
 * (after the migrations), so Martin can read them even when its role was
 * created later. A failure is logged and never blocks the start.
 */
@Injectable()
export class TilesGrants implements OnApplicationBootstrap {
  private readonly logger = new Logger('TilesGrants');

  constructor(@InjectPool() private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const outcome = await ensureTilesGrants(this.pool);
      if (outcome.granted.length > 0) {
        this.logger.log(
          { granted: outcome.granted },
          'Granted the Martin role tiles_ro its missing privileges on the tiles sources',
        );
      }
    } catch (error) {
      // Database errors without bound values (kit sanitizeError).
      this.logger.warn(
        { err: sanitizeError(error) },
        'Could not check the tiles_ro grants (Martin may not read the zone tiles)',
      );
    }
  }
}
