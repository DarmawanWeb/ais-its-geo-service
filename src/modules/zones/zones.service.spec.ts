import type { PageQuery } from '@darmawanweb/ais-its-contracts/api';
import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import {
  type AuditRecordedV1,
  EVENT_TYPES,
  type EventPayload,
  type EventType,
} from '@darmawanweb/ais-its-contracts/events';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { type AuditEntry, AuditService } from '@darmawanweb/ais-its-nest/audit';
import { type Principal, UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  Zone,
  ZoneChanges,
  ZoneDraft,
  ZoneReadScope,
} from '../../domain/zone.js';
import type { GeometryValidity } from '../../domain/zone-errors.js';
import type { ZoneGeometry } from '../../domain/zone-geometry.js';
import { GeoOutboxRelay } from '../outbox/geo-outbox.relay.js';
import { ZonesRepository } from './zones.repository.js';
import { effectiveChanges, ZonesService } from './zones.service.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const PAGE: PageQuery = { page: 1, pageSize: 20 };

const SQUARE: ZoneGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};

function user(orgId: string | null, ...roles: Role[]): UserPrincipal {
  return new UserPrincipal({
    id: '01900000-0000-7000-8000-0000000000f1',
    sessionId: '01900000-0000-7000-8000-0000000000f2',
    orgId,
    roles,
    email: 'user@example.test',
    name: 'User',
  });
}

interface OutboxEntry {
  readonly type: EventType;
  readonly data: unknown;
}

function visible(zone: Zone, scope: ZoneReadScope): boolean {
  return (
    scope.kind === 'all' || zone.orgId === null || zone.orgId === scope.orgId
  );
}

/**
 * `ZonesRepository` semantics in memory: tenancy scopes, the unique code per
 * owner and transactions that roll back the zones and the outbox together.
 */
class InMemoryZonesRepository {
  zones = new Map<string, Zone>();
  outbox: OutboxEntry[] = [];
  validity: GeometryValidity = { valid: true, reason: null, location: null };
  private clock = Date.parse('2026-01-01T00:00:00Z');

  async transaction<T>(work: (unit: InMemoryUnit) => Promise<T>): Promise<T> {
    const zones = new Map(this.zones);
    const outbox = [...this.outbox];
    try {
      return await work(new InMemoryUnit(this));
    } catch (error) {
      this.zones = zones;
      this.outbox = outbox;
      throw error;
    }
  }

  findById(id: string, scope: ZoneReadScope): Promise<Zone | undefined> {
    const zone = this.zones.get(id);
    return Promise.resolve(zone && visible(zone, scope) ? zone : undefined);
  }

  list(_filter: unknown, scope: ZoneReadScope, _page: PageQuery) {
    const rows = [...this.zones.values()]
      .filter((zone) => visible(zone, scope))
      .map((zone) => ({
        ...zone,
        geometryType: zone.geometry.type,
        vertexCount: 0,
        bbox: [0, 0, 0, 0] as const,
      }));
    return Promise.resolve({ rows, total: rows.length });
  }

  checkValidity(): Promise<GeometryValidity> {
    return Promise.resolve(this.validity);
  }

  idsAfter(after: string | null, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.zones.keys()]
        .sort()
        .filter((id) => after === null || id > after)
        .slice(0, limit),
    );
  }

  tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }
}

class InMemoryUnit {
  constructor(private readonly store: InMemoryZonesRepository) {}

  lockById(id: string, scope: ZoneReadScope): Promise<Zone | undefined> {
    return this.store.findById(id, scope);
  }

  lockByCode(orgId: string | null, code: string): Promise<Zone | undefined> {
    return Promise.resolve(
      [...this.store.zones.values()].find(
        (zone) => zone.orgId === orgId && zone.code === code,
      ),
    );
  }

  lockForRepublish(ids: readonly string[]): Promise<Zone[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const zone = this.store.zones.get(id);
        return zone === undefined ? [] : [zone];
      }),
    );
  }

  hasGeometry(id: string, geometry: ZoneGeometry): Promise<boolean> {
    return Promise.resolve(
      JSON.stringify(this.store.zones.get(id)?.geometry) ===
        JSON.stringify(geometry),
    );
  }

  insert(id: string, draft: ZoneDraft): Promise<Zone> {
    const duplicate = [...this.store.zones.values()].some(
      (zone) => zone.orgId === draft.orgId && zone.code === draft.code,
    );
    if (duplicate) {
      return Promise.reject(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'zones_org_code_key',
        }),
      );
    }
    const now = this.store.tick();
    const zone: Zone = { ...draft, id, createdAt: now, updatedAt: now };
    this.store.zones.set(id, zone);
    return Promise.resolve(zone);
  }

  update(id: string, changes: ZoneChanges): Promise<Zone> {
    const current = this.store.zones.get(id);
    if (current === undefined) return Promise.reject(new Error('no zone'));
    const zone = {
      ...current,
      ...changes,
      updatedAt: this.store.tick(),
    } as Zone;
    this.store.zones.set(id, zone);
    return Promise.resolve(zone);
  }

  delete(id: string): Promise<void> {
    this.store.zones.delete(id);
    return Promise.resolve();
  }

  enqueue<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
  ): Promise<string> {
    this.store.outbox.push({ type, data });
    return Promise.resolve(`outbox-${this.store.outbox.length}`);
  }
}

/** Builds audit records like the kit's `AuditService.buildRecord`. */
const audit = {
  buildRecord(entry: AuditEntry, principal?: Principal): AuditRecordedV1 {
    return {
      actorType: principal?.kind ?? 'system',
      actorId: principal?.id ?? null,
      orgId: entry.orgId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: null,
      userAgent: null,
      meta: { ...(entry.meta ?? {}) },
      at: '2026-01-01T00:00:00.000Z',
    };
  },
};

describe('ZonesService', () => {
  let service: ZonesService;
  let repository: InMemoryZonesRepository;
  let notified: number;

  beforeEach(async () => {
    repository = new InMemoryZonesRepository();
    notified = 0;
    const moduleRef = await Test.createTestingModule({
      providers: [
        ZonesService,
        { provide: ZonesRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        {
          provide: GeoOutboxRelay,
          useValue: {
            notify: () => {
              notified += 1;
            },
          },
        },
        { provide: MetricsService, useValue: new MetricsService() },
        { provide: APP_CONFIG, useValue: { ZONES_GEOJSON_MAX_FEATURES: 2 } },
      ],
    }).compile();
    service = moduleRef.get(ZonesService);
  });

  function createInput(code: string, global = false) {
    return {
      code,
      name: `Zone ${code}`,
      kind: 'restricted' as const,
      geometry: SQUARE,
      global,
    };
  }

  it('creates an organization zone with its snapshot and audit record in the outbox', async () => {
    const zone = await service.create(
      createInput('a-1'),
      user(ORG_A, 'org_admin'),
    );

    expect(zone).toMatchObject({
      orgId: ORG_A,
      code: 'a-1',
      kind: 'restricted',
      bufferM: 0,
      active: true,
      alertOnEnter: false,
      createdBy: '01900000-0000-7000-8000-0000000000f1',
    });
    expect(repository.outbox.map((entry) => entry.type)).toEqual([
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      EVENT_TYPES.AUDIT_RECORDED,
    ]);
    expect(repository.outbox[0]?.data).toMatchObject({
      id: zone.id,
      orgId: ORG_A,
      updatedAt: zone.updatedAt.toISOString(),
    });
    expect(repository.outbox[1]?.data).toMatchObject({
      action: 'zone.create',
      targetType: 'zone',
      targetId: zone.id,
      orgId: ORG_A,
      actorType: 'user',
    });
    expect(notified).toBe(1);
  });

  it('creates global zones for authority only', async () => {
    await expect(
      service.create(createInput('g-1', true), user(ORG_A, 'authority')),
    ).resolves.toMatchObject({ orgId: null });
    await expect(
      service.create(createInput('g-2', true), user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({ code: 'GLOBAL_ZONE_WRITE_FORBIDDEN' });
  });

  it('maps a duplicate code of the owner to 409 and writes nothing', async () => {
    await service.create(createInput('dup'), user(ORG_A, 'org_admin'));
    const outbox = repository.outbox.length;

    await expect(
      service.create(createInput('dup'), user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({ code: 'ZONE_CODE_TAKEN', status: 409 });
    expect(repository.outbox).toHaveLength(outbox);
    // Another owner may use the same code.
    await expect(
      service.create(createInput('dup'), user(ORG_B, 'org_admin')),
    ).resolves.toMatchObject({ orgId: ORG_B });
  });

  it('refuses a geometry PostGIS finds invalid, with the reason (422)', async () => {
    repository.validity = {
      valid: false,
      reason: 'Self-intersection',
      location: [104.05, 1.05],
    };
    await expect(
      service.create(createInput('bowtie'), user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({
      status: 422,
      code: 'ZONE_GEOMETRY_INVALID',
      extra: { reason: 'Self-intersection', location: [104.05, 1.05] },
    });
    expect(repository.zones.size).toBe(0);
  });

  it('hides organization zones from other organizations', async () => {
    const zone = await service.create(
      createInput('private'),
      user(ORG_A, 'org_admin'),
    );

    await expect(
      service.get(zone.id, user(ORG_B, 'viewer')),
    ).rejects.toMatchObject({
      code: 'ZONE_NOT_FOUND',
      status: 404,
    });
    await expect(
      service.get(zone.id, user(ORG_B, 'authority')),
    ).resolves.toMatchObject({
      id: zone.id,
    });
    const page = await service.list({}, PAGE, user(ORG_B, 'viewer'));
    expect(page.meta.total).toBe(0);
    await expect(
      service.list({ orgId: ORG_A }, PAGE, user(ORG_B, 'viewer')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('ignores an update that changes nothing (no event)', async () => {
    const zone = await service.create(
      createInput('same'),
      user(ORG_A, 'org_admin'),
    );
    const outbox = repository.outbox.length;

    const unchanged = await service.update(
      zone.id,
      { name: zone.name, geometry: SQUARE, active: true },
      user(ORG_A, 'org_admin'),
    );
    expect(unchanged).toEqual(zone);
    expect(repository.outbox).toHaveLength(outbox);
  });

  it('publishes a new snapshot and audits the changed fields', async () => {
    const zone = await service.create(
      createInput('change'),
      user(ORG_A, 'org_admin'),
    );

    const updated = await service.update(
      zone.id,
      { name: 'Renamed', bufferM: 250, source: 'Survey 2026' },
      user(ORG_A, 'org_admin'),
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      bufferM: 250,
      source: 'Survey 2026',
    });
    expect(repository.outbox.at(-2)).toMatchObject({
      type: EVENT_TYPES.GEO_ZONE_UPSERTED,
      data: { name: 'Renamed', properties: { source: 'Survey 2026' } },
    });
    expect(repository.outbox.at(-1)?.data).toMatchObject({
      action: 'zone.update',
      meta: { fields: ['name', 'bufferM', 'source'] },
    });
  });

  it('re-validates the stored geometry when the kind changes', async () => {
    const zone = await service.create(
      createInput('kind'),
      user(ORG_A, 'org_admin'),
    );

    await expect(
      service.update(zone.id, { kind: 'pipeline' }, user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({ code: 'ZONE_GEOMETRY_TYPE_NOT_ALLOWED' });
    expect(repository.zones.get(zone.id)?.kind).toBe('restricted');
  });

  it('refuses changes of zones of another organization or of global zones', async () => {
    const zone = await service.create(
      createInput('owned'),
      user(ORG_A, 'org_admin'),
    );
    const global = await service.create(
      createInput('shared', true),
      user(null, 'super_admin'),
    );

    await expect(
      service.update(zone.id, { name: 'x' }, user(ORG_B, 'authority')),
    ).rejects.toMatchObject({ code: 'ZONE_WRITE_FORBIDDEN', status: 403 });
    await expect(
      service.remove(global.id, user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({ code: 'GLOBAL_ZONE_WRITE_FORBIDDEN' });
  });

  it('deletes a zone with a tombstone', async () => {
    const zone = await service.create(
      createInput('gone'),
      user(ORG_A, 'org_admin'),
    );

    await service.remove(zone.id, user(ORG_A, 'org_admin'));
    expect(repository.zones.has(zone.id)).toBe(false);
    expect(repository.outbox.slice(-2)).toEqual([
      {
        type: EVENT_TYPES.GEO_ZONE_DELETED,
        data: { id: zone.id, orgId: ORG_A },
      },
      expect.objectContaining({
        type: EVENT_TYPES.AUDIT_RECORDED,
        data: expect.objectContaining({ action: 'zone.delete' }) as unknown,
      }),
    ]);
    await expect(
      service.remove(zone.id, user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({
      code: 'ZONE_NOT_FOUND',
    });
  });

  it('republishes every zone for super_admin only', async () => {
    await service.create(createInput('r-1'), user(ORG_A, 'org_admin'));
    await service.create(createInput('r-2', true), user(null, 'super_admin'));
    repository.outbox = [];

    await expect(
      service.republish(user(ORG_A, 'authority')),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ADMIN_REQUIRED',
      status: 403,
    });
    await expect(service.republish(user(null, 'super_admin'))).resolves.toBe(2);
    expect(repository.outbox.map((entry) => entry.type)).toEqual([
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      EVENT_TYPES.AUDIT_RECORDED,
    ]);
  });

  it('caps the map features and says so', async () => {
    const admin = user(null, 'super_admin');
    for (const code of ['m-1', 'm-2', 'm-3']) {
      await service.create(createInput(code, true), admin);
    }
    const all = [...repository.zones.values()];
    Object.assign(repository, {
      features: (_filter: unknown, _scope: unknown, limit: number) =>
        Promise.resolve(all.slice(0, limit)),
    });

    await expect(service.features({}, admin)).resolves.toMatchObject({
      truncated: true,
      limit: 2,
      zones: all.slice(0, 2),
    });
  });

  it('applies seeds idempotently by code', async () => {
    const seed = {
      code: 'mvp-seed',
      name: 'Seeded',
      kind: 'restricted' as const,
      geometry: SQUARE,
      bufferM: 0,
      alertOnEnter: false,
      active: true,
      properties: { note: 'seed' },
      source: 'dataset',
    };
    const created = await service.applySeed(seed, 'insert-missing');
    expect(created.outcome).toBe('created');
    expect(repository.outbox.at(-1)?.data).toMatchObject({
      actorType: 'system',
      meta: { seed: true },
    });
    const outbox = repository.outbox.length;

    await expect(
      service.applySeed(seed, 'insert-missing'),
    ).resolves.toMatchObject({
      outcome: 'kept',
    });
    await expect(service.applySeed(seed, 'update')).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    expect(repository.outbox).toHaveLength(outbox);
    await expect(
      service.applySeed({ ...seed, bufferM: 10 }, 'update'),
    ).resolves.toMatchObject({ outcome: 'updated', zone: { bufferM: 10 } });
  });
});

describe('effectiveChanges', () => {
  const current: Zone = {
    id: '01900000-0000-7000-8000-0000000000c1',
    orgId: null,
    code: 'z',
    name: 'Zone',
    kind: 'restricted',
    geometry: SQUARE,
    bufferM: 0,
    alertOnEnter: false,
    active: true,
    properties: {},
    source: 'A',
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it('keeps only the fields that differ and clears the source with null', () => {
    expect(
      effectiveChanges(current, {
        name: 'Zone',
        active: false,
        source: null,
        geometry: undefined,
      }),
    ).toEqual({ active: false, source: null });
  });

  it('validates the properties of the resulting kind', () => {
    expect(() =>
      effectiveChanges(current, {
        kind: 'shallow_water',
        properties: { depthM: -3 },
        geometry: undefined,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
