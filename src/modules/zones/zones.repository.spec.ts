import { describe, expect, it } from 'vitest';

import { geometryTypeFromPostgis } from './postgis-geometry-type.js';
import { escapeLikePattern } from './zones.repository.js';

describe('escapeLikePattern', () => {
  it('makes LIKE wildcards and the escape character literal', () => {
    expect(escapeLikePattern('100% sure_ok\\')).toBe('100\\% sure\\_ok\\\\');
    expect(escapeLikePattern('Batam anchorage')).toBe('Batam anchorage');
  });
});

describe('geometryTypeFromPostgis', () => {
  it('maps PostGIS GeometryType() names to GeoJSON types', () => {
    expect(geometryTypeFromPostgis('LINESTRING')).toBe('LineString');
    expect(geometryTypeFromPostgis('MULTIPOLYGON')).toBe('MultiPolygon');
    expect(geometryTypeFromPostgis('GeometryCollection')).toBe(
      'GeometryCollection',
    );
  });

  it('refuses types GeoJSON cannot represent', () => {
    expect(() => geometryTypeFromPostgis('CIRCULARSTRING')).toThrow(RangeError);
  });
});
