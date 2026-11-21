import { type PageQuery, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import type {
  EventPayload,
  EventType,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type Database,
  geoJsonToGeography,
  geographyAsGeoJson,
  geographyIntersectsBBox,
  InjectDb,
  InjectPool,
  type Pool,
  type PoolClient,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { enqueueEvent } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from '../../db/schema.js';
import type {
  Zone,
  ZoneChanges,
  ZoneDraft,
  ZoneFilter,
  ZoneReadScope,
  ZoneSummary,
} from '../../domain/zone.js';
import type { GeometryValidity } from '../../domain/zone-errors.js';
import type { ZoneGeometry } from '../../domain/zone-geometry.js';
import { geometryTypeFromPostgis } from './postgis-geometry-type.js';

const { zones } = schema;

/** Name of the unique constraint `(org_id, code)` in `0001_init.sql`. */
export const ZONE_CODE_CONSTRAINT = 'zones_org_code_key';

/** Decimal digits of coordinates read back from PostGIS (1e-9° ≈ 0.1 mm). */
export const STORED_GEOMETRY_DIGITS = 9;

/** Decimal digits of the map FeatureCollection (1e-6° ≈ 0.11 m). */
export const MAP_GEOMETRY_DIGITS = 6;

/** Columns of a full zone; `geometry` is the stored geography as GeoJSON. */
function zoneColumns(digits: number = STORED_GEOMETRY_DIGITS) {
  return {
    id: zones.id,
    orgId: zones.orgId,
    code: zones.code,
    name: zones.name,
    kind: zones.kind,
    geometry: geographyAsGeoJson(zones.geom, digits),
    bufferM: zones.bufferM,
    alertOnEnter: zones.alertOnEnter,
    active: zones.active,
    properties: zones.properties,
    source: zones.source,
    createdBy: zones.createdBy,
    createdAt: zones.createdAt,
    updatedAt: zones.updatedAt,
  };
}

/** Columns of a zone summary: geometry facts instead of the geometry. */
const summaryColumns = {
  id: zones.id,
  orgId: zones.orgId,
  code: zones.code,
  name: zones.name,
  kind: zones.kind,
  bufferM: zones.bufferM,
  alertOnEnter: zones.alertOnEnter,
  active: zones.active,
  properties: zones.properties,
  source: zones.source,
  createdBy: zones.createdBy,
  createdAt: zones.createdAt,
  updatedAt: zones.updatedAt,
  postgisType: sql<string>`GeometryType(${zones.geom}::geometry)`,
  vertexCount: sql<number>`ST_NPoints(${zones.geom}::geometry)`,
  minLon: sql<number>`ST_XMin(${zones.geom}::geometry)`,
  minLat: sql<number>`ST_YMin(${zones.geom}::geometry)`,
  maxLon: sql<number>`ST_XMax(${zones.geom}::geometry)`,
  maxLat: sql<number>`ST_YMax(${zones.geom}::geometry)`,
};

/** A row selected with {@link summaryColumns}. */
interface SummaryRow extends Omit<ZoneSummary, 'geometryType' | 'bbox'> {
  readonly postgisType: string;
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

function toSummary(row: SummaryRow): ZoneSummary {
  const { postgisType, minLon, minLat, maxLon, maxLat, ...zone } = row;
  return {
    ...zone,
    geometryType: geometryTypeFromPostgis(postgisType),
    bbox: [minLon, minLat, maxLon, maxLat],
  };
}

/** Escapes `%`, `_` and `\` so user input matches literally in LIKE patterns. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The tenancy condition of a read scope (spec §8.5). */
function scopeCondition(scope: ZoneReadScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  return scope.orgId === null
    ? isNull(zones.orgId)
    : or(isNull(zones.orgId), eq(zones.orgId, scope.orgId));
}

function filterConditions(filter: ZoneFilter): (SQL | undefined)[] {
  const search =
    filter.search === undefined
      ? undefined
      : `%${escapeLikePattern(filter.search)}%`;
  return [
    filter.kinds === undefined || filter.kinds.length === 0
      ? undefined
      : inArray(zones.kind, [...filter.kinds]),
    filter.active === undefined ? undefined : eq(zones.active, filter.active),
    filter.bbox === undefined
      ? undefined
      : geographyIntersectsBBox(zones.geom, filter.bbox),
    filter.orgId === undefined ? undefined : eq(zones.orgId, filter.orgId),
    search === undefined
      ? undefined
      : or(ilike(zones.code, search), ilike(zones.name, search)),
  ];
}

/** One page of zone summaries and the total across pages. */
export interface ZonePage {
  readonly rows: ZoneSummary[];
  readonly total: number;
}

/**
 * Drizzle/PostGIS access to `zones`. Reads take a {@link ZoneReadScope}, so
 * tenancy is enforced in SQL; writes happen in a {@link ZoneUnitOfWork}
 * (one transaction with the outbox).
 */
@Injectable()
export class ZonesRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /**
   * Runs `work` in one transaction: the zone writes and their outbox rows
   * commit or roll back together.
   */
  transaction<T>(work: (unit: ZoneUnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) =>
      work(new ZoneUnitOfWork(client)),
    );
  }

  /** A zone in the scope, with its geometry; `undefined` when not visible. */
  async findById(id: string, scope: ZoneReadScope): Promise<Zone | undefined> {
    const [row] = await this.db
      .select(zoneColumns())
      .from(zones)
      .where(and(eq(zones.id, id), scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** One page of zone summaries, ordered by kind, name and id. */
  async list(
    filter: ZoneFilter,
    scope: ZoneReadScope,
    page: PageQuery,
  ): Promise<ZonePage> {
    const where = and(scopeCondition(scope), ...filterConditions(filter));
    const [rows, totals] = await Promise.all([
      this.db
        .select(summaryColumns)
        .from(zones)
        .where(where)
        .orderBy(asc(zones.kind), asc(zones.name), asc(zones.id))
        .limit(page.pageSize)
        .offset(pageOffset(page)),
      this.db.select({ total: count() }).from(zones).where(where),
    ]);
    return { rows: rows.map(toSummary), total: totals[0]?.total ?? 0 };
  }

  /**
   * Zones with geometries rounded to {@link MAP_GEOMETRY_DIGITS} for the
   * map, at most `limit` rows (callers ask for one more to detect truncation).
   */
  features(
    filter: ZoneFilter,
    scope: ZoneReadScope,
    limit: number,
  ): Promise<Zone[]> {
    return this.db
      .select(zoneColumns(MAP_GEOMETRY_DIGITS))
      .from(zones)
      .where(and(scopeCondition(scope), ...filterConditions(filter)))
      .orderBy(asc(zones.kind), asc(zones.name), asc(zones.id))
      .limit(limit);
  }

  /**
   * PostGIS validity of a geometry (`ST_IsValidDetail`, OGC Simple
   * Features rules evaluated by GEOS on the lon/lat coordinates).
   */
  async checkValidity(geometry: ZoneGeometry): Promise<GeometryValidity> {
    const result = await this.db.execute<{
      valid: boolean;
      reason: string | null;
      lon: number | null;
      lat: number | null;
    }>(sql`
      SELECT (d).valid AS valid, (d).reason AS reason,
             ST_X((d).location) AS lon, ST_Y((d).location) AS lat
        FROM (SELECT ST_IsValidDetail(ST_GeomFromGeoJSON(${JSON.stringify(geometry)})) AS d) AS detail`);
    const row = result.rows[0];
    if (row === undefined) throw new Error('ST_IsValidDetail returned no row');
    return {
      valid: row.valid,
      reason: row.valid ? null : row.reason,
      location:
        row.valid || row.lon === null || row.lat === null
          ? null
          : [row.lon, row.lat],
    };
  }

  /**
   * The explicit repair used by seeds of known-invalid legacy datasets only
   * (never by the API): `ST_MakeValid`, keeping the polygonal part as a
   * MultiPolygon (`ST_CollectionExtract(…, 3)`).
   */
  async makeValidMultiPolygon(geometry: ZoneGeometry): Promise<ZoneGeometry> {
    const result = await this.db.execute<{ geometry: ZoneGeometry }>(sql`
      SELECT ST_AsGeoJSON(
               ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON(${JSON.stringify(geometry)})), 3)),
               ${sql.raw(String(STORED_GEOMETRY_DIGITS))})::json AS geometry`);
    const row = result.rows[0];
    if (row === undefined) throw new Error('ST_MakeValid returned no row');
    return row.geometry;
  }

  /** Ids of every zone after `afterId` (keyset order), for republication. */
  async idsAfter(afterId: string | null, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: zones.id })
      .from(zones)
      .where(afterId === null ? undefined : gt(zones.id, afterId))
      .orderBy(asc(zones.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }
}

/**
 * Writes of one transaction: zone rows locked, inserted, updated or
 * deleted, and the events of the change appended to the outbox with the
 * same client (kit `enqueueEvent`), so they commit atomically.
 */
export class ZoneUnitOfWork {
  private readonly db: Database<typeof schema>;

  constructor(private readonly client: PoolClient) {
    this.db = drizzle({ client, schema });
  }

  /** Locks a zone visible in the scope (`FOR UPDATE`) and returns it. */
  async lockById(id: string, scope: ZoneReadScope): Promise<Zone | undefined> {
    const [row] = await this.db
      .select(zoneColumns())
      .from(zones)
      .where(and(eq(zones.id, id), scopeCondition(scope)))
      .limit(1)
      .for('update');
    return row;
  }

  /** Locks the zone with this code of the owner (`FOR UPDATE`), if any. */
  async lockByCode(
    orgId: string | null,
    code: string,
  ): Promise<Zone | undefined> {
    const [row] = await this.db
      .select(zoneColumns())
      .from(zones)
      .where(
        and(
          orgId === null ? isNull(zones.orgId) : eq(zones.orgId, orgId),
          eq(zones.code, code),
        ),
      )
      .limit(1)
      .for('update');
    return row;
  }

  /**
   * Locks zones for reading (`FOR SHARE`): a concurrent change of the same
   * zone waits, so a republished snapshot is never older than a change
   * committed before it in the outbox.
   */
  lockForRepublish(ids: readonly string[]): Promise<Zone[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db
      .select(zoneColumns())
      .from(zones)
      .where(inArray(zones.id, [...ids]))
      .orderBy(asc(zones.id))
      .for('share');
  }

  /**
   * `true` when the stored geometry of the zone has exactly these vertices
   * in this order (`ST_OrderingEquals`: the vertex order of a pipeline line
   * matters for the EWS distance).
   */
  async hasGeometry(id: string, geometry: ZoneGeometry): Promise<boolean> {
    const [row] = await this.db
      .select({
        same: sql<boolean>`ST_OrderingEquals(${zones.geom}::geometry, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326))`,
      })
      .from(zones)
      .where(eq(zones.id, id));
    return row?.same === true;
  }

  /** Inserts a zone; a duplicate code violates {@link ZONE_CODE_CONSTRAINT}. */
  async insert(id: string, draft: ZoneDraft): Promise<Zone> {
    const [row] = await this.db
      .insert(zones)
      .values({
        id,
        orgId: draft.orgId,
        code: draft.code,
        name: draft.name,
        kind: draft.kind,
        geom: geoJsonToGeography(draft.geometry),
        bufferM: draft.bufferM,
        alertOnEnter: draft.alertOnEnter,
        active: draft.active,
        properties: { ...draft.properties },
        source: draft.source,
        createdBy: draft.createdBy,
      })
      .returning(zoneColumns());
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  /**
   * Applies the changes. `updated_at` strictly increases per zone (at least
   * 1 ms after the previous value, whatever the clocks of concurrent
   * transactions): consumers such as the Detector SDK `ZoneIndex` drop
   * snapshots older than the one they hold.
   */
  async update(id: string, changes: ZoneChanges): Promise<Zone> {
    const { geometry, properties, ...fields } = changes;
    const [row] = await this.db
      .update(zones)
      .set({
        ...definedFields(fields),
        ...(geometry === undefined
          ? {}
          : { geom: geoJsonToGeography(geometry) }),
        ...(properties === undefined ? {} : { properties: { ...properties } }),
        updatedAt: sql`greatest(clock_timestamp(), ${zones.updatedAt} + interval '1 millisecond')`,
      })
      .where(eq(zones.id, id))
      .returning(zoneColumns());
    if (row === undefined)
      throw new Error(`UPDATE of zone ${id} matched no row`);
    return row;
  }

  /** Deletes a zone (locked before by the caller). */
  async delete(id: string): Promise<void> {
    await this.db.delete(zones).where(eq(zones.id, id));
  }

  /**
   * Appends an event to the outbox in this transaction; the payload is
   * validated against the contracts schema now (`InvalidEventError`).
   *
   * @returns the envelope id (= `Nats-Msg-Id`).
   */
  enqueue<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
  ): Promise<string> {
    return enqueueEvent(this.client, type, data);
  }
}

/** The scalar changes without `undefined` members (absent = keep). */
function definedFields(
  fields: Omit<ZoneChanges, 'geometry' | 'properties'>,
): Partial<
  Pick<
    typeof zones.$inferInsert,
    'name' | 'kind' | 'bufferM' | 'alertOnEnter' | 'active' | 'source'
  >
> {
  return {
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.kind === undefined ? {} : { kind: fields.kind }),
    ...(fields.bufferM === undefined ? {} : { bufferM: fields.bufferM }),
    ...(fields.alertOnEnter === undefined
      ? {}
      : { alertOnEnter: fields.alertOnEnter }),
    ...(fields.active === undefined ? {} : { active: fields.active }),
    ...(fields.source === undefined ? {} : { source: fields.source }),
  };
}
