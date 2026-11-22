import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { countGeometryPositions } from '@darmawanweb/ais-its-contracts/domain';
import { Injectable, Logger } from '@nestjs/common';

import { ZoneGeometryInvalidError } from '../../domain/zone-errors.js';
import { GEOMETRY_REPAIR_METHOD } from '../zones/zones.repository.js';
import {
  type SeedMode,
  type SeedOutcome,
  type SeedZoneDefinition,
  ZonesService,
} from '../zones/zones.service.js';
import {
  batamSeedZone,
  pipelineSeedZone,
  type SeedDatasetFile,
  type SeedZone,
} from './legacy-datasets.js';

/** Parts of a geometry (polygons of a MultiPolygon, 1 otherwise). */
function partCount(geometry: SeedZoneDefinition['geometry']): number {
  return geometry.type === 'MultiPolygon' ? geometry.coordinates.length : 1;
}

/** The repository root (`src/` and `dist/` are one level below it). */
const ROOT = new URL('../../../', import.meta.url);

/** A dataset of the seed: its file and the mapping to a zone. */
interface SeedDataset {
  readonly path: string;
  readonly toZone: (file: unknown, dataset: SeedDatasetFile) => SeedZone;
}

/** The seed datasets, applied in this order (spec §13.6). */
const DATASETS: readonly SeedDataset[] = [
  { path: 'data/legacy/pipeline.json', toZone: pipelineSeedZone },
  { path: 'data/legacy/batam.json', toZone: batamSeedZone },
];

/** What the seed did with one zone. */
export interface SeedResult {
  readonly code: string;
  readonly id: string;
  readonly outcome: SeedOutcome;
  /** `true` when the dataset geometry was repaired ({@link GEOMETRY_REPAIR_METHOD}). */
  readonly repaired: boolean;
}

/**
 * `pnpm seed`: the global zones of the MVP datasets, idempotent by code.
 * Each zone goes through the same validation, transaction, outbox
 * (`geo.zone.upserted.v1`) and audit trail (system actor) as API writes.
 */
@Injectable()
export class ZoneSeeder {
  private readonly logger = new Logger('ZoneSeeder');

  constructor(private readonly zones: ZonesService) {}

  /** Applies every dataset; see {@link SeedMode}. */
  async seed(mode: SeedMode = 'insert-missing'): Promise<SeedResult[]> {
    const results: SeedResult[] = [];
    for (const dataset of DATASETS) {
      const bytes = await readFile(new URL(dataset.path, ROOT));
      const file = {
        path: dataset.path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const seed = dataset.toZone(JSON.parse(bytes.toString('utf8')), file);
      const { zone, repaired } = await this.prepared(seed);
      const applied = await this.zones.applySeed(zone, mode);
      const result: SeedResult = {
        code: zone.code,
        id: applied.zone.id,
        outcome: applied.outcome,
        repaired,
      };
      this.logger.log(
        { ...result, dataset: dataset.path },
        `Seed zone ${result.code}: ${result.outcome}`,
      );
      results.push(result);
    }
    return results;
  }

  /**
   * The seed zone with its geometry repaired when the dataset is known to be
   * invalid ({@link GEOMETRY_REPAIR_METHOD}: overlapping parts are merged,
   * nothing of their area is lost): logged and recorded in
   * `properties.geometryRepair` (method, GEOS reason and location, vertices
   * and parts before and after) so the change is never silent.
   */
  private async prepared(
    seed: SeedZone,
  ): Promise<{ zone: SeedZoneDefinition; repaired: boolean }> {
    const validity = await this.zones.checkValidity(seed.zone.geometry);
    if (validity.valid) return { zone: seed.zone, repaired: false };
    if (!seed.repairInvalidGeometry) {
      throw new ZoneGeometryInvalidError(validity);
    }
    const geometry = await this.zones.repairMultiPolygon(seed.zone.geometry);
    this.logger.warn(
      {
        code: seed.zone.code,
        reason: validity.reason,
        location: validity.location,
        method: GEOMETRY_REPAIR_METHOD,
      },
      'Invalid dataset geometry repaired explicitly (recorded in properties.geometryRepair)',
    );
    return {
      repaired: true,
      zone: {
        ...seed.zone,
        geometry,
        properties: {
          ...seed.zone.properties,
          geometryRepair: {
            method: GEOMETRY_REPAIR_METHOD,
            reason: validity.reason,
            location: validity.location,
            verticesBefore: countGeometryPositions(seed.zone.geometry),
            verticesAfter: countGeometryPositions(geometry),
            partsBefore: partCount(seed.zone.geometry),
            partsAfter: partCount(geometry),
          },
        },
      },
    };
  }
}
