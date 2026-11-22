import {
  type ZoneFeatureSource,
  zoneFeatureProperties,
} from './zone-snapshot.js';

/**
 * The web map layer `GET /api/v2/zones/geojson`: a GeoJSON FeatureCollection
 * (RFC 7946 §3.3) whose size is bounded whatever the data volume. Rules:
 * - geometries are simplified for the requested zoom (Douglas-Peucker,
 *   topology preserving) and rounded to {@link MAP_GEOMETRY_DIGITS} decimals;
 * - a response holds at most `maxFeatures` features and `maxVertices`
 *   vertices: it is the longest prefix of the zones (ordered by kind, name,
 *   id) within both budgets, and says when and why it was cut;
 * - it is produced and sent chunk by chunk, so memory does not grow with it.
 *
 * Methodology: cartographic display rules of the platform, not analytic
 * methods (proposed catalog id `geo.map_simplification`, see the README).
 */

/** Decimal digits of the map coordinates (1e-6° ≈ 0.11 m). */
export const MAP_GEOMETRY_DIGITS = 6;

/** Width of a map tile in pixels (MapLibre GL: the world is 512 × 2^zoom px wide). */
export const MAP_TILE_SIZE_PX = 512;

/** Highest zoom level accepted by the map layer. */
export const MAP_MAX_ZOOM = 24;

/** Simplification tolerance in pixels of the requested zoom. */
export const MAP_SIMPLIFICATION_PX = 0.5;

/**
 * Douglas-Peucker tolerance for a zoom level: half a pixel of a 512-px
 * tile in degrees of longitude, `0.5 × 360 / (512 × 2^zoom)` (0.35° at zoom
 * 0, 3.4e-4° ≈ 38 m at zoom 10). A pixel spans fewer degrees of latitude
 * than of longitude (× cos φ in Web Mercator), so the tolerance stays below
 * one pixel up to 60° of latitude.
 *
 * Units: degrees.
 *
 * @param zoom - map zoom level (0–24); absent = full resolution.
 * @returns 0 (no simplification) without a zoom, or when the tolerance is
 *   below the {@link MAP_GEOMETRY_DIGITS}-decimal rounding (zoom ≥ 19).
 * @see https://maplibre.org/maplibre-style-spec/sources/ (512-px vector tiles)
 * @see https://postgis.net/docs/ST_SimplifyPreserveTopology.html
 */
export function simplificationToleranceDeg(zoom: number | undefined): number {
  if (zoom === undefined) return 0;
  const tolerance =
    (MAP_SIMPLIFICATION_PX * 360) / (MAP_TILE_SIZE_PX * 2 ** zoom);
  return tolerance < 10 ** -MAP_GEOMETRY_DIGITS ? 0 : tolerance;
}

/** Budgets of one map response. */
export interface MapLayerLimits {
  readonly maxFeatures: number;
  readonly maxVertices: number;
}

/** Which budget cut a response. */
export type MapTruncation = 'features' | 'vertices';

/** Features and vertices written so far. */
export interface MapLayerTotals {
  readonly features: number;
  readonly vertices: number;
}

/**
 * The budget the next feature (of `vertices` vertices, after
 * simplification) would exceed, or `undefined` when it fits.
 */
export function exceededBudget(
  totals: MapLayerTotals,
  vertices: number,
  limits: MapLayerLimits,
): MapTruncation | undefined {
  if (totals.features + 1 > limits.maxFeatures) return 'features';
  if (totals.vertices + vertices > limits.maxVertices) return 'vertices';
  return undefined;
}

/**
 * Groups candidates, in order, into fetch chunks of at most `maxVertices`
 * stored vertices each (a larger candidate is a chunk of its own), so a
 * chunk of geometries held in memory stays small.
 */
export function planFetchChunks<T extends { readonly vertexCount: number }>(
  candidates: readonly T[],
  maxVertices: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let vertices = 0;
  for (const candidate of candidates) {
    if (current.length > 0 && vertices + candidate.vertexCount > maxVertices) {
      chunks.push(current);
      current = [];
      vertices = 0;
    }
    current.push(candidate);
    vertices += candidate.vertexCount;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** A map feature read from PostGIS: zone fields and the simplified geometry as GeoJSON text. */
export interface MapFeatureRow extends ZoneFeatureSource {
  /** `ST_AsGeoJSON` of the simplified geometry (trusted JSON text). */
  readonly geometryJson: string;
  /** Vertices of the simplified geometry. */
  readonly vertices: number;
}

/** How a map response ended (foreign members of the FeatureCollection). */
export interface MapLayerSummary {
  readonly truncated: boolean;
  readonly truncatedBy: MapTruncation | null;
  readonly featureCount: number;
  readonly vertexCount: number;
  readonly limits: MapLayerLimits;
  readonly zoom: number | null;
  readonly toleranceDeg: number;
}

/** What the map use case yields: the features in order, then the summary. */
export type MapLayerEvent =
  | { readonly kind: 'feature'; readonly feature: MapFeatureRow }
  | { readonly kind: 'end'; readonly summary: MapLayerSummary };

/** One Feature as JSON text, the PostGIS geometry text spliced in unparsed. */
export function featureJson(row: MapFeatureRow): string {
  const properties = JSON.stringify(zoneFeatureProperties(row));
  return `{"type":"Feature","id":${JSON.stringify(row.id)},"geometry":${row.geometryJson},"properties":${properties}}`;
}

/** The foreign members of the collection after its features. */
function summaryJson(summary: MapLayerSummary): string {
  return [
    `"truncated":${String(summary.truncated)}`,
    `"truncatedBy":${JSON.stringify(summary.truncatedBy)}`,
    `"limit":${String(summary.limits.maxFeatures)}`,
    `"vertexLimit":${String(summary.limits.maxVertices)}`,
    `"featureCount":${String(summary.featureCount)}`,
    `"vertexCount":${String(summary.vertexCount)}`,
    `"zoom":${JSON.stringify(summary.zoom)}`,
    `"toleranceDeg":${String(summary.toleranceDeg)}`,
  ].join(',');
}

/**
 * Serializes the events of a map layer as one GeoJSON FeatureCollection,
 * one string per feature, so the HTTP response can be streamed.
 *
 * @throws {Error} when the events end without a summary.
 */
export async function* featureCollectionJson(
  events: AsyncIterable<MapLayerEvent>,
): AsyncGenerator<string> {
  yield '{"type":"FeatureCollection","features":[';
  let first = true;
  for await (const event of events) {
    if (event.kind === 'end') {
      yield `],${summaryJson(event.summary)}}`;
      return;
    }
    yield `${first ? '' : ','}${featureJson(event.feature)}`;
    first = false;
  }
  throw new Error('The map layer ended without a summary');
}
