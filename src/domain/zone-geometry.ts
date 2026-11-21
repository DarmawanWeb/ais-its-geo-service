import { type FieldError, issuesToFieldErrors } from '@darmawanweb/ais-its-contracts/api';
import {
  type BBox,
  countGeometryPositions,
  GEOMETRY_TYPES,
  type GeoJsonGeometry,
  GeoJsonGeometrySchema,
  type GeoJsonPosition,
  type GeoJsonSimpleGeometry,
  type GeometryType,
  geometryBBox,
  ZONE_MAX_VERTICES,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';

import {
  ZoneBufferRequiredError,
  ZoneGeometryTooComplexError,
  ZoneGeometryTypeNotAllowedError,
} from './zone-errors.js';

/**
 * Input rules of zone geometries (docs/PLATFORM_SPEC.md §13.6): GeoJSON
 * structure and WGS84 bounds, geometry type per zone kind, at most
 * {@link ZONE_MAX_VERTICES} vertices and a buffer for point zones. The
 * topological validity (`ST_IsValid`) needs PostGIS and is checked by the
 * zones repository; nothing here repairs a geometry.
 *
 * Methodology: these are input-validation rules of the platform, not a
 * catalogued analytic method (proposed catalog id `geo.zone_geometry_rules`,
 * see the README).
 *
 * @see https://www.rfc-editor.org/rfc/rfc7946 (GeoJSON, WGS84 lon/lat positions)
 * @see docs/PLATFORM_SPEC.md §13.6
 */

/** A 2-D GeoJSON position `[lon, lat]` in WGS84 degrees. */
export type PlanarPosition = readonly [lon: number, lat: number];

/** A zone geometry: GeoJSON in WGS84 degrees without altitude. */
export type ZoneGeometry = GeoJsonGeometry;

/** Geometry types of areas. */
const AREAS: readonly GeometryType[] = ['Polygon', 'MultiPolygon'];
/** Geometry types of lines. */
const LINES: readonly GeometryType[] = ['LineString', 'MultiLineString'];
/** Geometry types of points (a point zone is a circle of radius `bufferM`). */
const POINTS: readonly GeometryType[] = ['Point', 'MultiPoint'];

/**
 * Geometry types each zone kind accepts:
 * - `pipeline`: lines (the EWS measures the distance to the pipeline line);
 * - areas that vessels are inside of (`transhipment_area`, `fishing_ground`,
 *   `mpa`, `shallow_water`): polygons;
 * - `restricted`, `anchorage`, `port`: polygons, or points with a radius
 *   (`bufferM`), as charts and port registries give them;
 * - `tss_lane`: polygons or lane centre lines;
 * - `custom`: any geometry, including collections.
 */
export const ZONE_GEOMETRY_TYPES: Readonly<
  Record<ZoneKind, readonly GeometryType[]>
> = {
  pipeline: LINES,
  transhipment_area: AREAS,
  fishing_ground: AREAS,
  mpa: AREAS,
  shallow_water: AREAS,
  restricted: [...AREAS, ...POINTS],
  anchorage: [...AREAS, ...POINTS],
  port: [...AREAS, ...POINTS],
  tss_lane: [...AREAS, ...LINES],
  custom: GEOMETRY_TYPES,
};

/** Hint added to coordinate range errors (the most common mistake is `[lat, lon]`). */
const POSITION_HINT = 'GeoJSON positions are [longitude, latitude] in WGS84';

/**
 * Parses untrusted GeoJSON into a zone geometry: structure (RFC 7946,
 * closed rings, non-empty parts), WGS84 bounds (lon −180…180, lat −90…90)
 * and finite numbers. Members other than `type`/`coordinates`/`geometries`
 * are dropped, and so is a third coordinate (zones are 2-D; the column is
 * `geography(Geometry,4326)` without Z).
 *
 * @param field - name of the request field, prefixed to error paths.
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with one field error per problem.
 */
export function parseZoneGeometry(
  input: unknown,
  field = 'geometry',
): ZoneGeometry {
  const result = GeoJsonGeometrySchema.safeParse(input);
  if (!result.success) {
    throw new ValidationFailedError(
      geometryFieldErrors(issuesToFieldErrors(result.error.issues), field),
      `Invalid GeoJSON geometry (${POSITION_HINT})`,
    );
  }
  return toPlanarGeometry(result.data);
}

/** Prefixes paths with the request field and explains coordinate range errors. */
function geometryFieldErrors(
  errors: readonly FieldError[],
  field: string,
): FieldError[] {
  return errors.map((error) => {
    const path = error.field === '' ? field : `${field}.${error.field}`;
    const isRange = error.code === 'too_big' || error.code === 'too_small';
    const isCoordinate = /(^|\.)coordinates(\.\d+)*$/.test(error.field);
    return {
      ...error,
      field: path,
      message:
        isRange && isCoordinate
          ? `${error.message} (${POSITION_HINT})`
          : error.message,
    };
  });
}

/** The position without altitude. */
function planar(position: GeoJsonPosition): GeoJsonPosition {
  return [position[0], position[1]];
}

function planarSimple(geometry: GeoJsonSimpleGeometry): GeoJsonSimpleGeometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: planar(geometry.coordinates) };
    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map(planar),
      };
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map(planar),
      };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) => line.map(planar)),
      };
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => ring.map(planar)),
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(planar)),
        ),
      };
  }
}

/** The geometry with every position reduced to `[lon, lat]`. */
export function toPlanarGeometry(geometry: GeoJsonGeometry): ZoneGeometry {
  return geometry.type === 'GeometryCollection'
    ? {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map(planarSimple),
      }
    : planarSimple(geometry);
}

/**
 * Topological dimension of a geometry: 0 for points, 1 for lines, 2 for
 * polygons; a collection has the highest dimension of its members.
 */
export function geometryDimension(geometry: ZoneGeometry): 0 | 1 | 2 {
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return 0;
    case 'LineString':
    case 'MultiLineString':
      return 1;
    case 'Polygon':
    case 'MultiPolygon':
      return 2;
    case 'GeometryCollection':
      return geometry.geometries.reduce<0 | 1 | 2>((highest, member) => {
        const dimension = geometryDimension(member);
        return dimension > highest ? dimension : highest;
      }, 0);
  }
}

/** Vertices of a geometry (closing positions of rings included). */
export function geometryVertexCount(geometry: ZoneGeometry): number {
  return countGeometryPositions(geometry);
}

/** `[minLon, minLat, maxLon, maxLat]` of a geometry. */
export function zoneGeometryBBox(geometry: ZoneGeometry): BBox {
  return geometryBBox(geometry);
}

/**
 * At most `maxVertices` vertices (default {@link ZONE_MAX_VERTICES} = 50 000):
 * checked before any PostGIS work on the geometry.
 *
 * @throws {ZoneGeometryTooComplexError} `422 ZONE_GEOMETRY_TOO_COMPLEX`
 */
export function assertVertexLimit(
  geometry: ZoneGeometry,
  maxVertices: number = ZONE_MAX_VERTICES,
): void {
  const vertices = geometryVertexCount(geometry);
  if (vertices > maxVertices) {
    throw new ZoneGeometryTooComplexError(vertices, maxVertices);
  }
}

/**
 * Checks the kind-dependent rules of a parsed geometry:
 * 1. the geometry type is one of {@link ZONE_GEOMETRY_TYPES} for the kind;
 * 2. at most `maxVertices` vertices ({@link assertVertexLimit});
 * 3. point zones (dimension 0) have `bufferM > 0`.
 *
 * @throws {ZoneGeometryTypeNotAllowedError} `422 ZONE_GEOMETRY_TYPE_NOT_ALLOWED`
 * @throws {ZoneGeometryTooComplexError} `422 ZONE_GEOMETRY_TOO_COMPLEX`
 * @throws {ZoneBufferRequiredError} `422 ZONE_BUFFER_REQUIRED`
 */
export function assertZoneGeometryRules(
  kind: ZoneKind,
  geometry: ZoneGeometry,
  bufferM: number,
  maxVertices: number = ZONE_MAX_VERTICES,
): void {
  const allowed = ZONE_GEOMETRY_TYPES[kind];
  if (!allowed.includes(geometry.type)) {
    throw new ZoneGeometryTypeNotAllowedError(kind, geometry.type, allowed);
  }
  assertVertexLimit(geometry, maxVertices);
  if (geometryDimension(geometry) === 0 && !(bufferM > 0)) {
    throw new ZoneBufferRequiredError(geometry.type);
  }
}
