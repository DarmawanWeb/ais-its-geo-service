import type { GeometryType } from '@darmawanweb/ais-its-contracts/domain';

/** PostGIS `GeometryType()` names (upper case) → GeoJSON geometry types. */
const POSTGIS_GEOMETRY_TYPES: Readonly<Record<string, GeometryType>> = {
  POINT: 'Point',
  MULTIPOINT: 'MultiPoint',
  LINESTRING: 'LineString',
  MULTILINESTRING: 'MultiLineString',
  POLYGON: 'Polygon',
  MULTIPOLYGON: 'MultiPolygon',
  GEOMETRYCOLLECTION: 'GeometryCollection',
};

/**
 * The GeoJSON type of a PostGIS `GeometryType()` result.
 *
 * @throws {RangeError} for types GeoJSON cannot represent (curves, TINs),
 *   which the registry never stores.
 */
export function geometryTypeFromPostgis(postgisType: string): GeometryType {
  const type = POSTGIS_GEOMETRY_TYPES[postgisType.toUpperCase()];
  if (type === undefined) {
    throw new RangeError(`Unexpected PostGIS geometry type ${postgisType}`);
  }
  return type;
}
