import { InjectConfig } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../config.js';
import type { ZoneFilter, ZoneReadScope } from '../../domain/zone.js';
import {
  exceededBudget,
  type MapLayerEvent,
  type MapLayerLimits,
  type MapLayerTotals,
  type MapTruncation,
  planFetchChunks,
  simplificationToleranceDeg,
} from '../../domain/zone-map.js';
import { assertOwnerFilter, readScopeOf } from './zone-access.js';
import { type MapCandidate, ZonesRepository } from './zones.repository.js';

/** Candidates (ids and stored vertex counts) read per query. */
const CANDIDATE_BATCH = 500;

/** Stored vertices of the geometries read per query (≈ 2.4 MB of GeoJSON text). */
const FETCH_CHUNK_VERTICES = 100_000;

/** A request for the map layer. */
export interface MapLayerRequest {
  readonly filter: ZoneFilter;
  /** Map zoom level; the geometries are simplified for it (absent = full resolution). */
  readonly zoom?: number | undefined;
}

/**
 * The web map layer `GET /api/v2/zones/geojson` (rules in
 * `domain/zone-map.ts`): the visible zones in layer order, simplified for
 * the zoom, within `ZONES_GEOJSON_MAX_FEATURES` features and
 * `ZONES_GEOJSON_MAX_VERTICES` vertices whatever the scope (authority and
 * super_admin see every organization's zones), read from PostgreSQL in
 * small chunks while the response is streamed.
 */
@Injectable()
export class ZoneMapService {
  private readonly limits: MapLayerLimits;

  constructor(
    private readonly repository: ZonesRepository,
    @InjectConfig() config: Config,
  ) {
    this.limits = {
      maxFeatures: config.ZONES_GEOJSON_MAX_FEATURES,
      maxVertices: config.ZONES_GEOJSON_MAX_VERTICES,
    };
  }

  /**
   * Checks the access and reads the first candidates now, so that refusals
   * and database errors become problem responses before streaming starts;
   * the returned events then read the geometries chunk by chunk.
   *
   * @throws {ForbiddenError} `403` for an owner filter on another organization.
   */
  async layer(
    request: MapLayerRequest,
    principal: Principal,
  ): Promise<AsyncIterable<MapLayerEvent>> {
    const { filter } = request;
    if (filter.orgId !== undefined) assertOwnerFilter(principal, filter.orgId);
    const scope = readScopeOf(principal);
    const first = await this.repository.mapCandidates(
      filter,
      scope,
      null,
      CANDIDATE_BATCH,
    );
    return this.events(filter, scope, first, request.zoom);
  }

  private async *events(
    filter: ZoneFilter,
    scope: ZoneReadScope,
    first: MapCandidate[],
    zoom: number | undefined,
  ): AsyncGenerator<MapLayerEvent> {
    const toleranceDeg = simplificationToleranceDeg(zoom);
    let totals: MapLayerTotals = { features: 0, vertices: 0 };
    let truncatedBy: MapTruncation | undefined;
    let candidates = first;
    batches: while (candidates.length > 0) {
      for (const chunk of planFetchChunks(candidates, FETCH_CHUNK_VERTICES)) {
        const rows = await this.repository.mapFeatures(
          chunk.map((candidate) => candidate.id),
          filter,
          scope,
          toleranceDeg,
        );
        for (const row of rows) {
          truncatedBy = exceededBudget(totals, row.vertices, this.limits);
          if (truncatedBy !== undefined) break batches;
          totals = {
            features: totals.features + 1,
            vertices: totals.vertices + row.vertices,
          };
          yield { kind: 'feature', feature: row };
        }
      }
      const last = candidates.at(-1);
      if (candidates.length < CANDIDATE_BATCH || last === undefined) break;
      candidates = await this.repository.mapCandidates(
        filter,
        scope,
        last,
        CANDIDATE_BATCH,
      );
    }
    yield {
      kind: 'end',
      summary: {
        truncated: truncatedBy !== undefined,
        truncatedBy: truncatedBy ?? null,
        featureCount: totals.features,
        vertexCount: totals.vertices,
        limits: this.limits,
        zoom: zoom ?? null,
        toleranceDeg,
      },
    };
  }
}
