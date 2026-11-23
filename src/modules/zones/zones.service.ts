import { isDeepStrictEqual } from 'node:util';

import {
  type PageQuery,
  type Paginated,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { newId, type ZoneKind } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { DomainError, InjectConfig } from '@darmawanweb/ais-its-nest';
import type { AuditEntry, AuditRequest } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { isUniqueViolation } from '@darmawanweb/ais-its-nest/db';
import {
  type Counter,
  MetricsService,
} from '@darmawanweb/ais-its-nest/metrics';
import { OutboxRelay } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import type { Config } from '../../config.js';
import type {
  Zone,
  ZoneChanges,
  ZoneDraft,
  ZoneFilter,
  ZoneSummary,
} from '../../domain/zone.js';
import {
  type GeometryValidity,
  ZoneCodeTakenError,
  ZoneGeometryInvalidError,
  ZoneNotFoundError,
} from '../../domain/zone-errors.js';
import {
  assertNoAntimeridianCrossing,
  assertVertexLimit,
  assertZoneGeometryRules,
  geometryVertexCount,
  parseZoneGeometry,
  type ZoneGeometry,
} from '../../domain/zone-geometry.js';
import { parseZoneProperties } from '../../domain/zone-properties.js';
import { zonePublicationError } from '../../domain/zone-publication.js';
import { assertZoneQuota, type ZoneQuota } from '../../domain/zone-quota.js';
import { toZoneSnapshot, toZoneTombstone } from '../../domain/zone-snapshot.js';
import { assertZoneVersion, type IfMatch } from '../../domain/zone-version.js';
import { PublicationLimits } from '../outbox/publication-limits.js';
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

/** A zone draft checked without saving (`POST /zones/validate`); geometry and properties are untrusted. */
export interface ValidateZoneInput {
  readonly kind: ZoneKind;
  readonly geometry: unknown;
  /** Default 0, as on create. */
  readonly bufferM?: number | undefined;
  /** Default `{}`, as on create (every property key is optional). */
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

/** Outcome of a dry-run validation of a zone draft. */
export interface ZoneValidation {
  /** The geometry as it would be stored (altitudes dropped); `null` when its structure is invalid. */
  readonly geometry: ZoneGeometry | null;
  /**
   * The problem `POST /zones` would answer for the draft (the first rule it
   * breaks, cheapest first: `400` structure or properties, `422` kind rules,
   * vertex limit, buffer, antimeridian, PostGIS validity); `null` when valid.
   */
  readonly problem: DomainError | null;
}

/** Zones per transaction when republishing. */
const REPUBLISH_BATCH_SIZE = 100;

/**
 * Use cases of the zones registry (spec §13.6): tenancy, input validation
 * (GeoJSON, kind rules, antimeridian, PostGIS validity; also as a dry run),
 * optimistic concurrency (`If-Match`), quotas per owner, and every change in
 * one transaction with its `geo.zone.*` event (refused when NATS could never
 * carry it) and its audit record in the outbox, published by the kit's
 * `OutboxRelay`. Domain metric: `aisits_geo_zone_changes_total{kind,action}`
 * (refusals are counted by `ZoneRejectionsInterceptor`).
 */
@Injectable()
export class ZonesService {
  private readonly logger = new Logger('ZonesService');
  private readonly changes: Counter<'kind' | 'action'>;
  private readonly quota: ZoneQuota;

  constructor(
    private readonly repository: ZonesRepository,
    private readonly relay: OutboxRelay,
    private readonly limits: PublicationLimits,
    metrics: MetricsService,
    @InjectConfig() config: Config,
  ) {
    this.changes = metrics.counter({
      name: 'geo_zone_changes_total',
      help: 'Committed zone changes by kind and action (create, update, delete, republish).',
      labelNames: ['kind', 'action'],
    });
    this.quota = {
      maxZones: config.ZONE_QUOTA_MAX_ZONES,
      maxVertices: config.ZONE_QUOTA_MAX_VERTICES,
    };
  }

  /** Creates a zone: global, or of the principal's active organization. */
  async create(
    input: CreateZoneInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Zone> {
    const orgId = ownerOfNewZone(principal, input.global ?? false);
    const draft = await this.validateDraft({
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
    });
    const zone = await this.insert(
      draft,
      (created) => createdEntry(created),
      principal,
      request,
    );
    this.committed([zone.kind], 'create');
    return zone;
  }

  /**
   * Checks a zone draft against the input rules of a create (README steps
   * 2–8: GeoJSON structure and bounds, geometry type per kind, vertex limit,
   * buffer of point zones, antimeridian, properties, PostGIS
   * `ST_IsValidDetail`) without saving or publishing anything. Owner, quota,
   * code, version and snapshot size are only checked by the write itself.
   * A broken rule is the result, not an error; unexpected failures (e.g.
   * the database) still throw.
   */
  async validate(input: ValidateZoneInput): Promise<ZoneValidation> {
    let geometry: ZoneGeometry | null = null;
    try {
      geometry = parseZoneGeometry(input.geometry);
      await this.checkDraftRules(
        input.kind,
        geometry,
        input.bufferM ?? 0,
        input.properties ?? {},
      );
      return { geometry, problem: null };
    } catch (error) {
      if (isDraftProblem(error)) return { geometry, problem: error };
      throw error;
    }
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

  /**
   * Changes a zone the principal may write. Fields equal to the stored
   * values are ignored; nothing is written (and no event is published) when
   * nothing changes. With `precondition` (`If-Match`), the change applies
   * only to that version of the zone.
   *
   * @throws {ZoneVersionConflictError} `412` when the zone changed since.
   */
  async update(
    id: string,
    input: UpdateZoneInput,
    principal: Principal,
    request?: AuditRequest,
    precondition?: IfMatch,
  ): Promise<Zone> {
    // Structure and PostGIS validity of a new geometry do not depend on the
    // stored zone: checked before the transaction locks the row.
    const geometry =
      input.geometry === undefined
        ? undefined
        : await this.validGeometry(input.geometry);
    const result = await this.repository.transaction(async (unit) => {
      const current = await unit.lockById(id, readScopeOf(principal));
      if (current === undefined) throw new ZoneNotFoundError(id);
      assertZoneWritable(principal, current);
      assertZoneVersion(precondition, current);
      const changes = effectiveChanges(current, { ...input, geometry });
      const fields = Object.keys(changes);
      if (fields.length === 0) return { zone: current, changed: false };
      if (changes.geometry !== undefined) {
        await this.assertQuota(unit, current.orgId, {
          zones: 0,
          vertices:
            geometryVertexCount(changes.geometry) -
            geometryVertexCount(current.geometry),
        });
      }
      const zone = await unit.update(id, changes);
      await this.enqueueChange(
        unit,
        zone,
        {
          action: 'zone.update',
          targetType: 'zone',
          targetId: zone.id,
          orgId: zone.orgId,
          meta: { code: zone.code, kind: zone.kind, fields },
        },
        principal,
        request,
      );
      return { zone, changed: true };
    });
    if (result.changed) this.committed([result.zone.kind], 'update');
    return result.zone;
  }

  /**
   * Deletes a zone the principal may write and publishes its tombstone;
   * with `precondition` (`If-Match`), only that version of the zone.
   *
   * @throws {ZoneVersionConflictError} `412` when the zone changed since.
   */
  async remove(
    id: string,
    principal: Principal,
    request?: AuditRequest,
    precondition?: IfMatch,
  ): Promise<void> {
    const deleted = await this.repository.transaction(async (unit) => {
      const current = await unit.lockById(id, readScopeOf(principal));
      if (current === undefined) throw new ZoneNotFoundError(id);
      assertZoneWritable(principal, current);
      assertZoneVersion(precondition, current);
      await unit.delete(id);
      await unit.enqueue(
        EVENT_TYPES.GEO_ZONE_DELETED,
        toZoneTombstone(current),
      );
      await unit.enqueueAudit(
        {
          action: 'zone.delete',
          targetType: 'zone',
          targetId: current.id,
          orgId: current.orgId,
          meta: { code: current.code, kind: current.kind },
        },
        principal,
        request,
      );
      return current;
    });
    this.committed([deleted.kind], 'delete');
  }

  /**
   * Enqueues the current snapshot of every zone, e.g. after the `GEO`
   * stream was lost or for a consumer that needs a full replay;
   * {@link REPUBLISH_BATCH_SIZE} zones per transaction. Reserved to
   * platform administrators by the route (`@RequirePlatformAdmin()`).
   *
   * @returns the number of snapshots enqueued.
   */
  async republish(
    principal: Principal,
    request?: AuditRequest,
  ): Promise<number> {
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
      unit.enqueueAudit(
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
      if (all.geometry !== undefined) {
        await this.assertQuota(unit, null, {
          zones: 0,
          vertices:
            geometryVertexCount(all.geometry) -
            geometryVertexCount(current.geometry),
        });
      }
      const zone = await unit.update(current.id, all);
      await this.enqueueChange(unit, zone, {
        action: 'zone.update',
        targetType: 'zone',
        targetId: zone.id,
        orgId: null,
        meta: { code: zone.code, kind: zone.kind, fields, seed: true },
      });
      return { zone, outcome: 'updated' as const };
    });
    if (existing !== undefined) {
      if (existing.outcome === 'updated') {
        this.committed([existing.zone.kind], 'update');
      }
      return existing;
    }
    const zone = await this.insert(draft, (created) => ({
      ...createdEntry(created),
      meta: { code: created.code, kind: created.kind, seed: true },
    }));
    this.committed([zone.kind], 'create');
    return { zone, outcome: 'created' };
  }

  /** PostGIS validity of a geometry (`ST_IsValidDetail`). */
  checkValidity(geometry: ZoneGeometry): Promise<GeometryValidity> {
    return this.repository.checkValidity(geometry);
  }

  /**
   * The explicit repair of a known-invalid legacy polygon dataset (seeds
   * only, never the API): `GEOMETRY_REPAIR_METHOD` of the repository
   * (`ST_MakeValid` with the `structure` method, overlaps merged).
   */
  repairMultiPolygon(geometry: ZoneGeometry): Promise<ZoneGeometry> {
    return this.repository.repairMultiPolygon(geometry);
  }

  /**
   * Inserts a validated zone with its snapshot and audit record, within
   * the owner's quota (system actor without `principal`).
   */
  private async insert(
    draft: ZoneDraft,
    auditEntry: (zone: Zone) => AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
  ): Promise<Zone> {
    try {
      return await this.repository.transaction(async (unit) => {
        await this.assertQuota(unit, draft.orgId, {
          zones: 1,
          vertices: geometryVertexCount(draft.geometry),
        });
        const created = await unit.insert(newId(), draft);
        await this.enqueueChange(
          unit,
          created,
          auditEntry(created),
          principal,
          request,
        );
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, ZONE_CODE_CONSTRAINT)) {
        throw new ZoneCodeTakenError(draft.code, draft.orgId, error);
      }
      throw error;
    }
  }

  /**
   * Appends the snapshot and the audit record of a created or changed zone.
   * The snapshot is measured against the NATS server's `max_payload` before
   * its row is inserted (`enqueueEvent({ maxBytes })`): one the server could
   * never carry rolls the transaction back with `422 ZONE_SNAPSHOT_TOO_LARGE`
   * instead of becoming a parked outbox row the detectors never see.
   */
  private async enqueueChange(
    unit: ZoneUnitOfWork,
    zone: Zone,
    auditEntry: AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
  ): Promise<void> {
    try {
      await unit.enqueue(EVENT_TYPES.GEO_ZONE_UPSERTED, toZoneSnapshot(zone), {
        maxBytes: this.limits.maxPayloadBytes(),
      });
    } catch (error) {
      throw zonePublicationError(error);
    }
    await unit.enqueueAudit(auditEntry, principal, request);
  }

  /**
   * Locks the owner's quota for the transaction and checks the change.
   *
   * @throws {ZoneQuotaExceededError} `409 ZONE_QUOTA_EXCEEDED`
   */
  private async assertQuota(
    unit: ZoneUnitOfWork,
    orgId: string | null,
    change: { readonly zones: number; readonly vertices: number },
  ): Promise<void> {
    if (change.zones <= 0 && change.vertices <= 0) return;
    const usage = await unit.lockOwnerUsage(orgId);
    assertZoneQuota(usage, change, this.quota, orgId);
  }

  /** Counts committed changes and wakes the relay. */
  private committed(kinds: readonly ZoneKind[], action: string): void {
    for (const kind of kinds) this.changes.inc({ kind, action });
    this.relay.notify();
  }

  /**
   * A draft whose geometry and properties passed every input rule, cheapest
   * first: GeoJSON structure (400), then {@link checkDraftRules}.
   */
  private async validateDraft(
    draft: Omit<ZoneDraft, 'geometry'> & { readonly geometry: unknown },
  ): Promise<ZoneDraft> {
    const geometry = parseZoneGeometry(draft.geometry);
    const properties = await this.checkDraftRules(
      draft.kind,
      geometry,
      draft.bufferM,
      draft.properties,
    );
    return { ...draft, geometry, properties };
  }

  /**
   * The input rules of a draft after its GeoJSON structure, cheapest first:
   * kind rules and vertex limit (422), the antimeridian (422), properties
   * (400), then PostGIS validity (422). Shared by the writes and the dry run.
   *
   * @returns the validated properties.
   */
  private async checkDraftRules(
    kind: ZoneKind,
    geometry: ZoneGeometry,
    bufferM: number,
    properties: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    assertZoneGeometryRules(kind, geometry, bufferM);
    assertNoAntimeridianCrossing(geometry);
    const parsed = parseZoneProperties(kind, properties);
    await this.assertValid(geometry);
    return parsed;
  }

  /**
   * Parses a geometry and checks the vertex limit, the antimeridian and the
   * PostGIS validity.
   */
  private async validGeometry(input: unknown): Promise<ZoneGeometry> {
    const geometry = parseZoneGeometry(input);
    assertVertexLimit(geometry);
    assertNoAntimeridianCrossing(geometry);
    await this.assertValid(geometry);
    return geometry;
  }

  /** @throws {ZoneGeometryInvalidError} when PostGIS `ST_IsValid` is false. */
  private async assertValid(geometry: ZoneGeometry): Promise<void> {
    const validity = await this.repository.checkValidity(geometry);
    if (!validity.valid) throw new ZoneGeometryInvalidError(validity);
  }
}

/**
 * `true` for the problems of the draft input rules (400 structure or
 * properties, 422 geometry rules); anything else is unexpected.
 */
function isDraftProblem(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    (error.status === 400 || error.status === 422)
  );
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
