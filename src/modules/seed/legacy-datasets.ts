import { GeoJsonMultiPolygonSchema } from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

import type { SeedZoneDefinition } from '../zones/zones.service.js';

/**
 * Seed datasets of the MVP (legacy `ais-its-cii-seemp-be/data/*.json`, kept
 * byte-identical in `data/legacy/`) mapped to global zones of the registry
 * (spec §13.6). Pure functions: the files are read and the zones written by
 * `ZoneSeeder`.
 */

/** A dataset file of the seed and its provenance. */
export interface SeedDatasetFile {
  /** Path relative to the repository root, e.g. `data/legacy/pipeline.json`. */
  readonly path: string;
  /** SHA-256 of the file bytes (hex). */
  readonly sha256: string;
}

/** A seed zone and how to treat its geometry. */
export interface SeedZone {
  readonly zone: SeedZoneDefinition;
  /**
   * `true` when the dataset is known to contain an invalid geometry that the
   * seed repairs explicitly (`ST_MakeValid`, recorded in
   * `properties.geometryRepair`). The API never repairs geometries.
   */
  readonly repairInvalidGeometry: boolean;
}

/** Provenance note of the MVP datasets (spec §13.6). */
export const MVP_DATASET_NOTE = 'MVP dataset, origin to be cited from the thesis';

/** Code of the pipeline seed zone. */
export const PIPELINE_ZONE_CODE = 'mvp-pipeline';

/** Code of the Batam transhipment seed zone. */
export const BATAM_ZONE_CODE = 'mvp-batam-transhipment';

/**
 * Buffer of the pipeline corridor, meters: the EWS warning distance
 * d_warning = 1 750 m (500 m prohibited + 1 250 m restricted zone around
 * installations at sea), which is also the legacy frontend's outer buffer.
 * The EWS itself (safety service) keeps its own 500 m / 1 750 m thresholds.
 *
 * @see ews.pipeline_distance_status (constant d_warning), docs/METHODOLOGY.md §5.1
 * @see https://peraturan.bpk.go.id/Details/161858/pp-no-27-tahun-2021 (PP 27/2021 Pasal 31(3))
 * @see https://migas.esdm.go.id/post/tumpahan-minyak-pipa-penyalur-minyak-pertamina-sesuai-standar
 */
export const PIPELINE_CORRIDOR_BUFFER_M = 1_750;

/** Legacy `data/pipeline.json`: `{ pipeline: [{ Latitude, Longitude, Name }] }`. */
const LegacyPipelineSchema = z.object({
  pipeline: z
    .array(
      z.object({
        Latitude: z.number().min(-90).max(90),
        Longitude: z.number().min(-180).max(180),
        Name: z.string().min(1),
      }),
    )
    .min(2),
});

/**
 * The subsea pipeline of the MVP as one global `pipeline` zone: a
 * LineString through the 61 kilometre points (KP) **in file order** — the
 * line the legacy EWS (`checkShipStatus`, turf `nearestPointOnLine`) measures
 * against, kept for numerical parity although the file is not in KP order
 * (it backtracks; 48.6 km in file order, 33.6 km in KP order). Every point
 * is kept as a marker `{ name, lat, lon }` in `properties.markers` (contracts
 * `PipelineZonePropertiesSchema`), the two different points labelled
 * "KP 42.200" included. Buffer {@link PIPELINE_CORRIDOR_BUFFER_M} m.
 *
 * Units: degrees (WGS84 datum assumed: the legacy file states none), meters.
 *
 * @method data.pipeline_route
 * @see docs/METHODOLOGY.md §15.2 (data.pipeline_route)
 * @see be-legacy/data/pipeline.json, be-legacy/src/utils/calculate-ews.ts:checkShipStatus
 */
export function pipelineSeedZone(
  file: unknown,
  dataset: SeedDatasetFile,
): SeedZone {
  // SOURCE: thesis — needs citation (KP list of the MVP; origin, datum and
  // design/as-laid status unknown, see data.pipeline_route).
  const { pipeline } = LegacyPipelineSchema.parse(file);
  return {
    repairInvalidGeometry: false,
    zone: {
      code: PIPELINE_ZONE_CODE,
      name: 'Subsea pipeline (MVP dataset)',
      kind: 'pipeline',
      geometry: {
        type: 'LineString',
        coordinates: pipeline.map((point) => [point.Longitude, point.Latitude]),
      },
      bufferM: PIPELINE_CORRIDOR_BUFFER_M,
      alertOnEnter: false,
      active: true,
      source: `legacy MVP backend ${dataset.path} (ais-its-cii-seemp-be data/pipeline.json)`,
      properties: {
        note: MVP_DATASET_NOTE,
        methodId: 'data.pipeline_route',
        vertexOrder:
          'legacy file order (parity with the MVP EWS); not sorted by KP',
        dataset: { ...dataset },
        markers: pipeline.map((point) => ({
          name: point.Name,
          lat: point.Latitude,
          lon: point.Longitude,
        })),
      },
    },
  };
}

/** Legacy `data/batam.json`: a FeatureCollection with one MultiPolygon feature. */
const LegacyBatamSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z
    .array(
      z.object({
        type: z.literal('Feature'),
        properties: z
          .object({
            PROVINSI: z.string().min(1).optional(),
            KODE_PROV: z.string().min(1).optional(),
          })
          .loose(),
        geometry: GeoJsonMultiPolygonSchema,
      }),
    )
    .length(1),
});

/**
 * The Batam transhipment area of the MVP as one global `transhipment_area`
 * zone: the MultiPolygon of legacy `data/batam.json` (73 parts, 795
 * vertices; the Kepulauan Riau province polygon, KODE_PROV 21). The legacy
 * code never read the file (transhipment used the Batam AIS feed flag); it
 * is NOT an authoritative transhipment, STS or anchorage area. Its parts
 * overlap (`ST_IsValid`: self-intersection), so the seed repairs it
 * explicitly and records the repair. Buffer 0 m, no geofence alerts.
 *
 * Units: degrees (WGS84 datum assumed).
 *
 * @method data.batam_area
 * @see docs/METHODOLOGY.md §15.3 (data.batam_area)
 * @see be-legacy/data/batam.json, be-legacy/src/config/ws-batam.ts
 */
export function batamSeedZone(
  file: unknown,
  dataset: SeedDatasetFile,
): SeedZone {
  // SOURCE: thesis — needs citation (mapshaper export of a province polygon,
  // licence unknown; the area should be defined by the thesis or the port
  // authority, see data.batam_area).
  const [feature] = LegacyBatamSchema.parse(file).features;
  if (feature === undefined) throw new RangeError('batam.json has no feature');
  return {
    repairInvalidGeometry: true,
    zone: {
      code: BATAM_ZONE_CODE,
      name: 'Batam transhipment area (MVP dataset)',
      kind: 'transhipment_area',
      geometry: feature.geometry,
      bufferM: 0,
      alertOnEnter: false,
      active: true,
      source: `legacy MVP backend ${dataset.path} (ais-its-cii-seemp-be data/batam.json)`,
      properties: {
        note: `${MVP_DATASET_NOTE}. Province land polygon (Kepulauan Riau), not an authoritative transhipment area definition`,
        methodId: 'data.batam_area',
        dataset: { ...dataset },
        ...(feature.properties.PROVINSI === undefined
          ? {}
          : { province: feature.properties.PROVINSI }),
        ...(feature.properties.KODE_PROV === undefined
          ? {}
          : { provinceCode: feature.properties.KODE_PROV }),
      },
    },
  };
}
