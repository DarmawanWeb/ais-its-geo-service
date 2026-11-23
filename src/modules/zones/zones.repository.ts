import { type PageQuery, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import type { BBox } from '@darmawanweb/ais-its-contracts/domain';
import type {
  EventPayload,
  EventType,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type AuditEntry,
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import {
  bboxEnvelope,
  type Database,
  geoJsonToGeography,
  geographyAsGeoJson,
  InjectDb,
  InjectPool,
  type Pool,
  type PoolClient,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import {
  type EnqueueEventOptions,
  enqueueEvent,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
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
import {
  MAP_GEOMETRY_DIGITS,
  type MapFeatureRow,
} from '../../domain/zone-map.js';
import type { ZoneUsage } from '../../domain/zone-quota.js';
import { geometryTypeFromPostgis } from './postgis-geometry-type.js';

const { zones } = schema;

/** Name of the unique constraint `(org_id, code)` in `0001_init.sql`. */
export const ZONE_CODE_CONSTRAINT = 'zones_org_code_key';

/** Decimal digits of coordinates read back from PostGIS (1e-9° ≈ 0.1 mm). */
export const STORED_GEOMETRY_DIGITS = 9;

/**
 * The explicit repair of a known-invalid legacy polygon dataset (seeds only,
 * never the API). The `structure` method of `ST_MakeValid` (GEOS ≥ 3.10)
 * unions the exterior rings, so areas covered by overlapping parts stay in
 * the zone; the default `linework` method would build areas by symmetric
 * difference and cut the overlaps out. Recorded in `properties.geometryRepair`.
 *
 * @see https://postgis.net/docs/ST_MakeValid.html
 */
export const GEOMETRY_REPAIR_METHOD =
  "ST_Multi(ST_CollectionExtract(ST_MakeValid(geom, 'method=structure'), 3))";

/** Columns of a full zone; `geometry` is the stored geography as GeoJSON. */
function zoneColumns() {
  return {
    id: zones.id,
    orgId: zones.orgId,
    code: zones.code,
    name: zones.name,
    kind: zones.kind,
    geometry: geographyAsGeoJson(zones.geom, STORED_GEOMETRY_DIGITS),
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
  vertexCount: zones.vertexCount,
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

/**
 * Zones whose area of effect — the geometry and every point within
 * `buffer_m` of it (a point zone is a circle) — may intersect the box, in
 * lon/lat space (box edges are meridians and parallels, as on the map). The
 * GiST index on the generated `extent` (box of the geometry grown by its
 * buffer) prefilters; the geometry, or its distance to the box within the
 * zone's conservative buffer radius in degrees (`zone_buffer_degrees`,
 * `0002_map_extent_quota_tiles.sql`), decides. Conservative: a zone at most
 * about 1 % (more near the poles) beyond its buffer may match; none whose
 * buffer reaches the box is missed.
 *
 * Units: `buffer_m` meters, the radius and the box degrees (WGS 84 lon/lat).
 *
 * @method geo.zone_buffer_extent
 * @see migrations/0002_map_extent_quota_tiles.sql (`zone_buffer_degrees`, `zone_extent`)
 */
export function bufferedBBoxCondition(bbox: BBox): SQL {
  const box = bboxEnvelope(bbox);
  return sql`(${zones.extent} && ${box} AND (ST_Intersects(${zones.geom}::geometry, ${box}) OR (${zones.bufferM} > 0 AND ST_DWithin(${zones.geom}::geometry, ${box}, zone_buffer_degrees(${zones.geom}, ${zones.bufferM})))))`;
}

/** The tenancy condition of a read scope (spec §8.5). */
function scopeCondition(scope: ZoneReadScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  return scope.orgId === null
    ? isNull(zones.orgId)
    : or(isNull(zones.orgId), eq(zones.orgId, scope.orgId));
}

/** Global zones only (`true`), organization zones only (`false`), or both. */
function ownerCondition(global: boolean | undefined): SQL | undefined {
  if (global === undefined) return undefined;
  return global ? isNull(zones.orgId) : isNotNull(zones.orgId);
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
    filter.bbox === undefined ? undefined : bufferedBBoxCondition(filter.bbox),
    filter.orgId === undefined ? undefined : eq(zones.orgId, filter.orgId),
    ownerCondition(filter.global),
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

/** A zone of the map layer before its geometry is read, in layer order. */
export interface MapCandidate {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  /** Stored vertices (before simplification). */
  readonly vertexCount: number;
}

/** Columns of a map feature except the geometry. */
const mapFeatureColumns = {
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
  updatedAt: zones.updatedAt,
};

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
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs `work` in one transaction: the zone writes, their events and their
   * audit records (outbox rows) commit or roll back together.
   */
  transaction<T>(work: (unit: ZoneUnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) =>
      work(new ZoneUnitOfWork(client, this.audit)),
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
   * The next zones of the map layer after `after` in layer order (kind,
   * name, id), with their stored vertex counts: no geometry is read.
   */
  mapCandidates(
    filter: ZoneFilter,
    scope: ZoneReadScope,
    after: MapCandidate | null,
    limit: number,
  ): Promise<MapCandidate[]> {
    return this.db
      .select({
        id: zones.id,
        kind: zones.kind,
        name: zones.name,
        vertexCount: zones.vertexCount,
      })
      .from(zones)
      .where(
        and(
          scopeCondition(scope),
          ...filterConditions(filter),
          after === null
            ? undefined
            : sql`(${zones.kind}, ${zones.name}, ${zones.id}) > (${after.kind}, ${after.name}, ${after.id}::uuid)`,
        ),
      )
      .orderBy(asc(zones.kind), asc(zones.name), asc(zones.id))
      .limit(limit);
  }

  /**
   * The map features of these zones, in the order of `ids`: the geometry
   * simplified with `ST_SimplifyPreserveTopology` (when `toleranceDeg > 0`)
   * and rounded to {@link MAP_GEOMETRY_DIGITS} decimals as GeoJSON text.
   * Scope and filter are applied again, so a zone changed since it was
   * listed is left out rather than shown stale.
   */
  async mapFeatures(
    ids: readonly string[],
    filter: ZoneFilter,
    scope: ZoneReadScope,
    toleranceDeg: number,
  ): Promise<MapFeatureRow[]> {
    if (ids.length === 0) return [];
    const geometry =
      toleranceDeg > 0
        ? sql`ST_SimplifyPreserveTopology(${zones.geom}::geometry, ${toleranceDeg}::double precision)`
        : sql`${zones.geom}::geometry`;
    const simplified = this.db
      .select({ ...mapFeatureColumns, g: geometry.as('g') })
      .from(zones)
      .where(
        and(
          inArray(zones.id, [...ids]),
          scopeCondition(scope),
          ...filterConditions(filter),
        ),
      )
      .as('s');
    const rows = await this.db
      .select({
        id: simplified.id,
        orgId: simplified.orgId,
        code: simplified.code,
        name: simplified.name,
        kind: simplified.kind,
        bufferM: simplified.bufferM,
        alertOnEnter: simplified.alertOnEnter,
        active: simplified.active,
        properties: simplified.properties,
        source: simplified.source,
        updatedAt: simplified.updatedAt,
        geometryJson: sql<string>`ST_AsGeoJSON(${simplified.g}, ${sql.raw(String(MAP_GEOMETRY_DIGITS))})`,
        vertices: sql<number>`ST_NPoints(${simplified.g})`,
      })
      .from(simplified);
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows.sort(
      (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
    );
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
   * Repairs a known-invalid legacy polygon dataset with
   * {@link GEOMETRY_REPAIR_METHOD} (seeds only, never the API).
   */
  async repairMultiPolygon(geometry: ZoneGeometry): Promise<ZoneGeometry> {
    const result = await this.db.execute<{ geometry: ZoneGeometry }>(sql`
      SELECT ST_AsGeoJSON(
               ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 'method=structure'), 3)),
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
 * deleted, and the events and audit records of the change appended to the
 * outbox with the same client (kit `enqueueEvent` and `AuditService.enqueue`),
 * so they commit atomically.
 */
export class ZoneUnitOfWork {
  private readonly db: Database<typeof schema>;

  constructor(
    private readonly client: PoolClient,
    private readonly audit: AuditService,
  ) {
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

  /**
   * Serializes the quota checks of one owner until the transaction ends
   * (transaction-scoped advisory lock; concurrent writes of other owners do
   * not wait), then reads what the owner holds from the stored vertex counts.
   */
  async lockOwnerUsage(orgId: string | null): Promise<ZoneUsage> {
    await this.client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`geo.zones.quota:${orgId ?? 'global'}`],
    );
    const [row] = await this.db
      .select({
        zones: count(),
        vertices: sql<string>`coalesce(sum(${zones.vertexCount}), 0)`,
      })
      .from(zones)
      .where(orgId === null ? isNull(zones.orgId) : eq(zones.orgId, orgId));
    return { zones: row?.zones ?? 0, vertices: Number(row?.vertices ?? 0) };
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
   * validated against the contracts schema now (`InvalidEventError`). With
   * `maxBytes` (the NATS `max_payload`), an event whose message would be
   * larger throws `EventTooLargeError` before the row is inserted.
   *
   * @returns the envelope id (= `Nats-Msg-Id`).
   */
  enqueue<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
    options: Pick<EnqueueEventOptions, 'maxBytes'> = {},
  ): Promise<string> {
    return enqueueEvent(this.client, type, data, options);
  }

  /**
   * Appends the `audit.recorded.v1` record of an entry to the outbox in
   * this transaction (kit `AuditService.enqueue`): published on
   * `audit.v1.<SERVICE_NAME>` after the commit, never when it rolls back.
   * Without a principal the actor is the system (seeds).
   *
   * @returns the envelope id.
   */
  enqueueAudit(
    entry: AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
  ): Promise<string> {
    return this.audit.enqueue(this.client, entry, principal, request);
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
