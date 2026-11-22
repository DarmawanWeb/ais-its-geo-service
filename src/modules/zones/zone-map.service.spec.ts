import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { describe, expect, it } from 'vitest';

import type { Config } from '../../config.js';
import type { ZoneFilter, ZoneReadScope } from '../../domain/zone.js';
import {
  type MapFeatureRow,
  type MapLayerEvent,
  simplificationToleranceDeg,
} from '../../domain/zone-map.js';
import { ZoneMapService } from './zone-map.service.js';
import type { MapCandidate, ZonesRepository } from './zones.repository.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';

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

/** A stored zone of the fake: its layer key, raw and simplified vertices. */
interface FakeZone {
  readonly id: string;
  readonly vertexCount: number;
  readonly simplified: number;
}

/** `mapCandidates` / `mapFeatures` over a sorted list, recording every call. */
class FakeMapRepository {
  readonly candidateCalls: (MapCandidate | null)[] = [];
  readonly featureCalls: string[][] = [];
  readonly tolerances: number[] = [];
  scope: ZoneReadScope | undefined;

  constructor(private readonly zones: readonly FakeZone[]) {}

  mapCandidates(
    _filter: ZoneFilter,
    scope: ZoneReadScope,
    after: MapCandidate | null,
    limit: number,
  ): Promise<MapCandidate[]> {
    this.scope = scope;
    this.candidateCalls.push(after);
    const start =
      after === null ? 0 : this.zones.findIndex((z) => z.id === after.id) + 1;
    return Promise.resolve(
      this.zones.slice(start, start + limit).map((zone) => ({
        id: zone.id,
        kind: 'mpa',
        name: zone.id,
        vertexCount: zone.vertexCount,
      })),
    );
  }

  mapFeatures(
    ids: readonly string[],
    _filter: ZoneFilter,
    _scope: ZoneReadScope,
    toleranceDeg: number,
  ): Promise<MapFeatureRow[]> {
    this.featureCalls.push([...ids]);
    this.tolerances.push(toleranceDeg);
    return Promise.resolve(
      ids.flatMap((id) => {
        const zone = this.zones.find((candidate) => candidate.id === id);
        return zone === undefined
          ? []
          : [
              {
                id,
                orgId: null,
                code: id,
                name: id,
                kind: 'mpa' as const,
                bufferM: 0,
                alertOnEnter: false,
                active: true,
                properties: {},
                source: null,
                updatedAt: new Date('2026-01-01T00:00:00Z'),
                geometryJson: '{"type":"Point","coordinates":[0,0]}',
                vertices: zone.simplified,
              },
            ];
      }),
    );
  }
}

function serviceOf(
  zones: readonly FakeZone[],
  limits: { features: number; vertices: number },
): { service: ZoneMapService; repository: FakeMapRepository } {
  const repository = new FakeMapRepository(zones);
  const config = {
    ZONES_GEOJSON_MAX_FEATURES: limits.features,
    ZONES_GEOJSON_MAX_VERTICES: limits.vertices,
  } as Config;
  return {
    service: new ZoneMapService(
      repository as unknown as ZonesRepository,
      config,
    ),
    repository,
  };
}

async function drain(
  events: AsyncIterable<MapLayerEvent>,
): Promise<{ ids: string[]; end: MapLayerEvent | undefined }> {
  const ids: string[] = [];
  let end: MapLayerEvent | undefined;
  for await (const event of events) {
    if (event.kind === 'feature') ids.push(event.feature.id);
    else end = event;
  }
  return { ids, end };
}

const zone = (id: string, vertexCount: number, simplified = vertexCount) => ({
  id,
  vertexCount,
  simplified,
});

describe('ZoneMapService', () => {
  const authority = user(ORG_A, 'authority');

  it('returns every zone with the simplification of the zoom when within budget', async () => {
    const { service, repository } = serviceOf(
      [zone('a', 50_000, 120), zone('b', 50_000, 80)],
      { features: 10, vertices: 1_000 },
    );
    const { ids, end } = await drain(
      await service.layer({ filter: {}, zoom: 8 }, authority),
    );
    expect(ids).toEqual(['a', 'b']);
    expect(end).toEqual({
      kind: 'end',
      summary: {
        truncated: false,
        truncatedBy: null,
        featureCount: 2,
        vertexCount: 200,
        limits: { maxFeatures: 10, maxVertices: 1_000 },
        zoom: 8,
        toleranceDeg: simplificationToleranceDeg(8),
      },
    });
    // 100 000 stored vertices per read: the two 50 000-vertex zones share one.
    expect(repository.featureCalls).toEqual([['a', 'b']]);
    expect(repository.tolerances).toEqual([simplificationToleranceDeg(8)]);
    expect(repository.scope).toEqual({ kind: 'all' });
  });

  it('cuts the response at the vertex budget (prefix) and stops reading', async () => {
    const { service, repository } = serviceOf(
      [
        zone('a', 60_000, 60_000),
        zone('b', 60_000, 60_000),
        zone('c', 60_000, 60_000),
      ],
      { features: 10, vertices: 100_000 },
    );
    const { ids, end } = await drain(
      await service.layer({ filter: {} }, authority),
    );
    expect(ids).toEqual(['a']);
    expect(end).toMatchObject({
      summary: {
        truncated: true,
        truncatedBy: 'vertices',
        featureCount: 1,
        vertexCount: 60_000,
        zoom: null,
        toleranceDeg: 0,
      },
    });
    // b was read (it did not fit), c never was.
    expect(repository.featureCalls).toEqual([['a'], ['b']]);
  });

  it('cuts the response at the feature budget', async () => {
    const { service } = serviceOf([zone('a', 5), zone('b', 5), zone('c', 5)], {
      features: 2,
      vertices: 1_000,
    });
    const { ids, end } = await drain(
      await service.layer({ filter: {} }, authority),
    );
    expect(ids).toEqual(['a', 'b']);
    expect(end).toMatchObject({
      summary: { truncated: true, truncatedBy: 'features', featureCount: 2 },
    });
  });

  it('reads candidates in batches after the last key', async () => {
    const zones = Array.from({ length: 1_201 }, (_, index) =>
      zone(`z${String(index).padStart(5, '0')}`, 1),
    );
    const { service, repository } = serviceOf(zones, {
      features: 5_000,
      vertices: 1_000_000,
    });
    const { ids } = await drain(await service.layer({ filter: {} }, authority));
    expect(ids).toHaveLength(1_201);
    expect(repository.candidateCalls.map((after) => after?.id ?? null)).toEqual(
      [null, 'z00499', 'z00999'],
    );
  });

  it('checks the owner filter before anything is streamed', async () => {
    const { service, repository } = serviceOf([zone('a', 5)], {
      features: 10,
      vertices: 1_000,
    });
    await expect(
      service.layer({ filter: { orgId: ORG_B } }, user(ORG_A, 'org_admin')),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.candidateCalls).toEqual([]);

    await service.layer({ filter: {} }, user(ORG_A, 'viewer'));
    expect(repository.scope).toEqual({ kind: 'tenant', orgId: ORG_A });
  });
});
