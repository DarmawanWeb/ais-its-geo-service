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
];
