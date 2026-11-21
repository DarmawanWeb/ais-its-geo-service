import { isDeepStrictEqual } from 'node:util';

import {
  type PageQuery,
  type Paginated,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { isPlatformAdmin } from '@darmawanweb/ais-its-contracts/auth';
import { newId, type ZoneKind } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AuditRecordedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import { DomainError, InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  type AuditEntry,
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable, Logger } from '@nestjs/common';
import type { Counter } from 'prom-client';

import type { Config } from '../../config.js';
import { isUniqueViolation } from '../../db/errors.js';
import type {
  Zone,
  ZoneChanges,
  ZoneDraft,
  ZoneFilter,
  ZoneSummary,
} from '../../domain/zone.js';
import {
  type GeometryValidity,
  PlatformAdminRequiredError,
  ZoneCodeTakenError,
  ZoneGeometryInvalidError,
  ZoneNotFoundError,
} from '../../domain/zone-errors.js';
import {
  assertVertexLimit,
  assertZoneGeometryRules,
  parseZoneGeometry,
  type ZoneGeometry,
} from '../../domain/zone-geometry.js';
import { parseZoneProperties } from '../../domain/zone-properties.js';
import { toZoneSnapshot, toZoneTombstone } from '../../domain/zone-snapshot.js';
import { GeoOutboxRelay } from '../outbox/geo-outbox.relay.js';
import {
  assertOwnerFilter,
  assertZoneWritable,
  ownerOfNewZone,
  readScopeOf,
} from './zone-access.js';
import {
  ZONE_CODE_CONSTRAINT,
  ZonesRepository,
  type ZoneUnitOfWork,
} from './zones.repository.js';

/** Fields of a new zone as received; geometry and properties are untrusted. */
export interface CreateZoneInput {
  readonly code: string;
  readonly name: string;
  readonly kind: ZoneKind;
  readonly geometry: unknown;
  readonly bufferM?: number | undefined;
  readonly alertOnEnter?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
  /** `null` or absent = unknown provenance. */
  readonly source?: string | null | undefined;
  /** `true` = global zone (`super_admin` / `authority`), else a zone of the active organization. */
  readonly global?: boolean | undefined;
}

/** Changes of a zone as received (`undefined` = keep; `source: null` clears it). */
export interface UpdateZoneInput {
  readonly name?: string | undefined;
  readonly kind?: ZoneKind | undefined;
  readonly geometry?: unknown;
  readonly bufferM?: number | undefined;
  readonly alertOnEnter?: boolean | undefined;
  readonly active?: boolean | undefined;
  /** Replaces the whole properties object. */
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
  readonly source?: string | null | undefined;
}

/** A global zone defined by a seed dataset (already parsed). */
export interface SeedZoneDefinition {
  readonly code: string;
  readonly name: string;
  readonly kind: ZoneKind;
  readonly geometry: ZoneGeometry;
  readonly bufferM: number;
  readonly alertOnEnter: boolean;
  readonly active: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly source: string;
}

/**
 * What a seed run does with an existing zone of the same code:
 * `insert-missing` keeps it as it is (operators' changes survive),
 * `update` overwrites the dataset fields when they differ.
 */
export type SeedMode = 'insert-missing' | 'update';

/** Outcome of one seed zone. */
export type SeedOutcome = 'created' | 'updated' | 'unchanged' | 'kept';

/** The map layer: zones and whether the limit cut it. */
export interface ZoneFeatureSet {
  readonly zones: readonly Zone[];
  readonly truncated: boolean;
  readonly limit: number;
}

/** Zones per transaction when republishing. */
const REPUBLISH_BATCH_SIZE = 100;

/**
 * Use cases of the zones registry (spec §13.6): tenancy, input validation
 * (GeoJSON, kind rules, PostGIS validity), and every change in one
 * transaction with its `geo.zone.*` event and its audit record in the
 * outbox. Domain metrics: `aisits_geo_zone_changes_total{kind,action}`,
 * `aisits_geo_zone_rejections_total{code}`.
 */
@Injectable()
export class ZonesService {
  private readonly logger = new Logger('ZonesService');
  private readonly changes: Counter<'kind' | 'action'>;
  private readonly rejections: Counter<'code'>;
  private readonly maxFeatures: number;

  constructor(
    private readonly repository: ZonesRepository,
    private readonly audit: AuditService,
    private readonly relay: GeoOutboxRelay,
    metrics: MetricsService,
    @InjectConfig() config: Config,
  ) {
    this.changes = metrics.counter({
      name: 'geo_zone_changes_total',
      help: 'Committed zone changes by kind and action (create, update, delete, republish).',
      labelNames: ['kind', 'action'],
    });
    this.rejections = metrics.counter({
      name: 'geo_zone_rejections_total',
      help: 'Zone writes refused by the input rules, by problem code.',
      labelNames: ['code'],
    });
    this.maxFeatures = config.ZONES_GEOJSON_MAX_FEATURES;
  }

  /** Creates a zone: global, or of the principal's active organization. */
  async create(
    input: CreateZoneInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Zone> {
    const orgId = ownerOfNewZone(principal, input.global ?? false);
    const draft = await this.validated(() =>
      this.validateDraft({
        orgId,
        code: input.code,
        name: input.name,
        kind: input.kind,
        geometry: input.geometry,
        bufferM: input.bufferM ?? 0,
        alertOnEnter: input.alertOnEnter ?? false,
        active: input.active ?? true,
        properties: input.properties ?? {},
        source: input.source ?? null,
        createdBy: principal.kind === 'user' ? principal.id : null,
      }),
    );
    const zone = await this.insert(draft, (created) =>
      this.audit.buildRecord(createdEntry(created), principal, request),
    );
    this.committed([zone.kind], 'create');
    return zone;
  }

  /** A zone visible to the principal, else `404 ZONE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<Zone> {
    const zone = await this.repository.findById(id, readScopeOf(principal));
    if (zone === undefined) throw new ZoneNotFoundError(id);
    return zone;
  }

  /** One page of the zones visible to the principal (without geometries). */
  async list(
    filter: ZoneFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<ZoneSummary>> {
    if (filter.orgId !== undefined) assertOwnerFilter(principal, filter.orgId);
    const { rows, total } = await this.repository.list(
      filter,
      readScopeOf(principal),
      page,
    );
    return toPaginated(rows, page, total);
  }

  /** The zones of the map layer, at most `ZONES_GEOJSON_MAX_FEATURES`. */
  async features(
    filter: ZoneFilter,
    principal: Principal,
  ): Promise<ZoneFeatureSet> {
    if (filter.orgId !== undefined) assertOwnerFilter(principal, filter.orgId);
    const limit = this.maxFeatures;
    const zones = await this.repository.features(
      filter,
      readScopeOf(principal),
      limit + 1,
    );
    return {
      zones: zones.slice(0, limit),
      truncated: zones.length > limit,
      limit,
    };
  }

  /**
   * Changes a zone the principal may write. Fields equal to the stored
   * values are ignored; nothing is written (and no event is published) when
   * nothing changes.
   */
  async update(
    id: string,
    input: UpdateZoneInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Zone> {
    // Structure and PostGIS validity of a new geometry do not depend on the
    // stored zone: checked before the transaction locks the row.
    const geometry =
      input.geometry === undefined
        ? undefined
        : await this.validated(() => this.validGeometry(input.geometry));
    const result = await this.repository.transaction(async (unit) => {
      const current = await unit.lockById(id, readScopeOf(principal));
      if (current === undefined) throw new ZoneNotFoundError(id);
      assertZoneWritable(principal, current);
      const changes = await this.validated(() =>
        effectiveChanges(current, { ...input, geometry }),
      );
      const fields = Object.keys(changes);
      if (fields.length === 0) return { zone: current, changed: false };
      const zone = await unit.update(id, changes);
      await this.enqueueChange(
        unit,
        zone,
        this.audit.buildRecord(
          {
            action: 'zone.update',
            targetType: 'zone',
            targetId: zone.id,
            orgId: zone.orgId,
            meta: { code: zone.code, kind: zone.kind, fields },
          },
          principal,
          request,
        ),
      );
      return { zone, changed: true };
    });
    if (result.changed) this.committed([result.zone.kind], 'update');
    return result.zone;
  }

  /** Deletes a zone the principal may write and publishes its tombstone. */
  async remove(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<void> {
    const deleted = await this.repository.transaction(async (unit) => {
      const current = await unit.lockById(id, readScopeOf(principal));
      if (current === undefined) throw new ZoneNotFoundError(id);
      assertZoneWritable(principal, current);
      await unit.delete(id);
      await unit.enqueue(
        EVENT_TYPES.GEO_ZONE_DELETED,
        toZoneTombstone(current),
      );
      await unit.enqueue(
        EVENT_TYPES.AUDIT_RECORDED,
        this.audit.buildRecord(
          {
            action: 'zone.delete',
            targetType: 'zone',
            targetId: current.id,
            orgId: current.orgId,
            meta: { code: current.code, kind: current.kind },
          },
          principal,
          request,
        ),
      );
      return current;
    });
    this.committed([deleted.kind], 'delete');
  }

  /**
   * Enqueues the current snapshot of every zone (`super_admin` only), e.g.
   * after the `GEO` stream was lost or for a consumer that needs a full
   * replay; {@link REPUBLISH_BATCH_SIZE} zones per transaction.
   *
   * @returns the number of snapshots enqueued.
   */
  async republish(
    principal: Principal,
    request?: AuditRequest,
  ): Promise<number> {
    if (!isPlatformAdmin(principal)) {
      throw new PlatformAdminRequiredError('republish zone snapshots');
    }
    let after: string | null = null;
    let enqueued = 0;
    for (;;) {
      const ids = await this.repository.idsAfter(after, REPUBLISH_BATCH_SIZE);
      const last = ids.at(-1);
      if (last === undefined) break;
      const kinds = await this.repository.transaction(async (unit) => {
        const zones = await unit.lockForRepublish(ids);
        for (const zone of zones) {
          await unit.enqueue(
            EVENT_TYPES.GEO_ZONE_UPSERTED,
            toZoneSnapshot(zone),
          );
        }
        return zones.map((zone) => zone.kind);
      });
      enqueued += kinds.length;
      this.committed(kinds, 'republish');
      after = last;
    }
    await this.repository.transaction((unit) =>
      unit.enqueue(
        EVENT_TYPES.AUDIT_RECORDED,
        this.audit.buildRecord(
          {
            action: 'zone.republish',
            targetType: 'zone',
            targetId: null,
            orgId: null,
            meta: { count: enqueued },
          },
          principal,
          request,
        ),
      ),
    );
    this.relay.notify();
    this.logger.log(
      { enqueued, principal: principal.id },
      'Zone snapshots enqueued for republication',
    );
    return enqueued;
  }

  /**
   * Applies a global seed zone idempotently by code (system actor, no
   * tenancy): creates it when missing; an existing zone is kept, or — in
   * `update` mode — overwritten with the dataset fields when they differ.
   */
  async applySeed(
    seed: SeedZoneDefinition,
    mode: SeedMode,
  ): Promise<{ zone: Zone; outcome: SeedOutcome }> {
    const draft = await this.validateDraft({
      ...seed,
      orgId: null,
      createdBy: null,
    });
    const existing = await this.repository.transaction(async (unit) => {
      const current = await unit.lockByCode(null, draft.code);
      if (current === undefined) return undefined;
      if (mode === 'insert-missing') {
        return { zone: current, outcome: 'kept' as const };
      }
      const changes = seedChanges(current, draft);
      const all: ZoneChanges = (await unit.hasGeometry(
        current.id,
        draft.geometry,
      ))
        ? changes
        : { ...changes, geometry: draft.geometry };
      const fields = Object.keys(all);
      if (fields.length === 0) {
        return { zone: current, outcome: 'unchanged' as const };
      }
      const zone = await unit.update(current.id, all);
      await this.enqueueChange(
        unit,
        zone,
        this.audit.buildRecord({
          action: 'zone.update',
          targetType: 'zone',
          targetId: zone.id,
          orgId: null,
          meta: { code: zone.code, kind: zone.kind, fields, seed: true },
        }),
      );
      return { zone, outcome: 'updated' as const };
    });
    if (existing !== undefined) {
      if (existing.outcome === 'updated') {
        this.committed([existing.zone.kind], 'update');
      }
      return existing;
    }
    const zone = await this.insert(draft, (created) =>
      this.audit.buildRecord({
        ...createdEntry(created),
        meta: { code: created.code, kind: created.kind, seed: true },
      }),
    );
    this.committed([zone.kind], 'create');
    return { zone, outcome: 'created' };
  }

  /** PostGIS validity of a geometry (`ST_IsValidDetail`). */
  checkValidity(geometry: ZoneGeometry): Promise<GeometryValidity> {
    return this.repository.checkValidity(geometry);
  }

  /**
   * The explicit repair of a known-invalid legacy polygon dataset (seeds
   * only, never the API): `ST_MakeValid`, polygons kept as a MultiPolygon.
   */
  makeValidMultiPolygon(geometry: ZoneGeometry): Promise<ZoneGeometry> {
    return this.repository.makeValidMultiPolygon(geometry);
  }

  /** Inserts a validated zone with its snapshot and audit record. */
  private async insert(
    draft: ZoneDraft,
    auditRecord: (zone: Zone) => AuditRecordedV1,
  ): Promise<Zone> {
    try {
      return await this.repository.transaction(async (unit) => {
        const created = await unit.insert(newId(), draft);
        await this.enqueueChange(unit, created, auditRecord(created));
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, ZONE_CODE_CONSTRAINT)) {
        throw new ZoneCodeTakenError(draft.code, draft.orgId, error);
      }
      throw error;
    }
  }

  /** Appends the snapshot and the audit record of a created or changed zone. */
  private async enqueueChange(
    unit: ZoneUnitOfWork,
    zone: Zone,
    auditRecord: AuditRecordedV1,
  ): Promise<void> {
    await unit.enqueue(EVENT_TYPES.GEO_ZONE_UPSERTED, toZoneSnapshot(zone));
    await unit.enqueue(EVENT_TYPES.AUDIT_RECORDED, auditRecord);
  }

  /** Counts committed changes and wakes the relay. */
  private committed(kinds: readonly ZoneKind[], action: string): void {
    for (const kind of kinds) this.changes.inc({ kind, action });
    this.relay.notify();
  }

  /**
   * A draft whose geometry and properties passed every input rule, cheapest
   * first: GeoJSON structure (400), kind rules and vertex limit (422),
   * properties (400), then PostGIS validity (422).
   */
  private async validateDraft(
    draft: Omit<ZoneDraft, 'geometry'> & { readonly geometry: unknown },
  ): Promise<ZoneDraft> {
    const geometry = parseZoneGeometry(draft.geometry);
    assertZoneGeometryRules(draft.kind, geometry, draft.bufferM);
    const properties = parseZoneProperties(draft.kind, draft.properties);
    await this.assertValid(geometry);
    return { ...draft, geometry, properties };
  }

  /** Parses a geometry, checks the vertex limit and the PostGIS validity. */
  private async validGeometry(input: unknown): Promise<ZoneGeometry> {
    const geometry = parseZoneGeometry(input);
    assertVertexLimit(geometry);
    await this.assertValid(geometry);
    return geometry;
  }

  /** @throws {ZoneGeometryInvalidError} when PostGIS `ST_IsValid` is false. */
  private async assertValid(geometry: ZoneGeometry): Promise<void> {
    const validity = await this.repository.checkValidity(geometry);
    if (!validity.valid) throw new ZoneGeometryInvalidError(validity);
  }

  /** Runs a validation step and counts its rejections by problem code. */
  private async validated<T>(step: () => T | Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof DomainError && error.status < 500) {
        this.rejections.inc({ code: error.code });
      }
      throw error;
    }
  }
}

/** The audit entry of a created zone. */
function createdEntry(zone: Zone): AuditEntry {
  return {
    action: 'zone.create',
    targetType: 'zone',
    targetId: zone.id,
    orgId: zone.orgId,
    meta: { code: zone.code, kind: zone.kind },
  };
}

/** `next` when it is given and differs from `stored`, else `undefined` (keep). */
function changed<T>(next: T | undefined, stored: T): T | undefined {
  return next !== undefined && !isDeepStrictEqual(next, stored)
    ? next
    : undefined;
}

/** The members of `value` that are not `undefined`. */
function definedMembers<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as Partial<T>;
}

/**
 * The changes that differ from the stored zone, validated against the
 * resulting zone: the kind rules for a new kind, geometry or buffer, and the
 * property schema of the resulting kind.
 *
 * @throws the 400/422 errors of {@link parseZoneProperties} and
 *   {@link assertZoneGeometryRules}.
 */
export function effectiveChanges(
  current: Zone,
  input: Omit<UpdateZoneInput, 'geometry'> & {
    readonly geometry: ZoneGeometry | undefined;
  },
): ZoneChanges {
  const kind = changed(input.kind, current.kind);
  const geometry = changed(input.geometry, current.geometry);
  const bufferM = changed(input.bufferM, current.bufferM);
  const resultingKind = kind ?? current.kind;
  let properties: Record<string, unknown> | undefined;
  if (input.properties !== undefined || kind !== undefined) {
    properties = changed(
      parseZoneProperties(
        resultingKind,
        input.properties ?? current.properties,
      ),
      current.properties,
    );
  }
  if (kind !== undefined || geometry !== undefined || bufferM !== undefined) {
    assertZoneGeometryRules(
      resultingKind,
      geometry ?? current.geometry,
      bufferM ?? current.bufferM,
    );
  }
  return definedMembers<ZoneChanges>({
    name: changed(input.name, current.name),
    kind,
    geometry,
    bufferM,
    alertOnEnter: changed(input.alertOnEnter, current.alertOnEnter),
    active: changed(input.active, current.active),
    source: changed(input.source, current.source),
    properties,
  });
}

/** The dataset fields (except the geometry) that differ from the stored zone. */
function seedChanges(current: Zone, draft: ZoneDraft): ZoneChanges {
  return definedMembers<ZoneChanges>({
    name: changed(draft.name, current.name),
    kind: changed(draft.kind, current.kind),
    bufferM: changed(draft.bufferM, current.bufferM),
    source: changed(draft.source, current.source),
    properties: changed(draft.properties, current.properties),
  });
}
