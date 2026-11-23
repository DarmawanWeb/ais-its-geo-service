/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // Seed zone kind pipeline from legacy data/pipeline.json (src/modules/seed/legacy-datasets.ts).
  'data.pipeline_route',
  // Seed zone kind transhipment_area from legacy data/batam.json (same file).
  'data.batam_area',
  // Geometry input rules: type per kind, vertex limit, buffer of point zones,
  // antimeridian, ST_IsValidDetail (src/domain/zone-geometry.ts#assertZoneGeometryRules).
  'geo.zone_geometry_rules',
  // Conservative buffer radius in degrees of the bbox filters
  // (src/modules/zones/zones.repository.ts#bufferedBBoxCondition, SQL zone_buffer_degrees).
  'geo.zone_buffer_extent',
  // Map layer simplification tolerance and budgets
  // (src/domain/zone-map.ts#simplificationToleranceDeg).
  'geo.map_simplification',
];
