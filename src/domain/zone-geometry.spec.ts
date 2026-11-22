import {
  ZONE_KINDS,
  ZONE_MAX_VERTICES,
} from '@darmawanweb/ais-its-contracts/domain';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { describe, expect, it } from 'vitest';

import {
  ZoneBufferRequiredError,
  ZoneGeometryTypeNotAllowedError,
} from './zone-errors.js';
import {
  assertNoAntimeridianCrossing,
  assertZoneGeometryRules,
  findAntimeridianCrossing,
  geometryDimension,
  geometryVertexCount,
  parseZoneGeometry,
  ZONE_GEOMETRY_TYPES,
  type ZoneGeometry,
  zoneGeometryBBox,
} from './zone-geometry.js';

const SQUARE: ZoneGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};

const LINE: ZoneGeometry = {
  type: 'LineString',
  coordinates: [
    [112.719384869178, -6.87197219605424],
    [112.719433852143, -6.86293886272091],
  ],
};

/** The field errors of a rejected geometry. */
function fieldErrors(input: unknown): { field: string; message: string }[] {
  try {
    parseZoneGeometry(input);
  } catch (error) {
    if (error instanceof ValidationFailedError) {
      return (error.errors ?? []).map(({ field, message }) => ({
        field,
        message,
      }));
    }
    throw error;
  }
  throw new Error('geometry was accepted');
}

/** A LineString with `count` vertices. */
function lineOf(count: number): ZoneGeometry {
  return {
    type: 'LineString',
    coordinates: Array.from({ length: count }, (_, index) => [
      100 + index * 1e-5,
      1,
    ]),
  };
}

describe('parseZoneGeometry', () => {
  it('accepts every GeoJSON geometry type in WGS84', () => {
    expect(parseZoneGeometry(SQUARE)).toEqual(SQUARE);
    expect(parseZoneGeometry(LINE)).toEqual(LINE);
    expect(
      parseZoneGeometry({
        type: 'GeometryCollection',
        geometries: [SQUARE, { type: 'Point', coordinates: [104, 1] }],
      }),
    ).toMatchObject({ type: 'GeometryCollection' });
  });

  it('drops altitudes and foreign members (zones are 2-D)', () => {
    expect(
      parseZoneGeometry({
        type: 'LineString',
        bbox: [104, 1, 104.1, 1.1],
        coordinates: [
          [104, 1, 12.5],
          [104.1, 1.1, 0],
        ],
      }),
    ).toEqual({
      type: 'LineString',
      coordinates: [
        [104, 1],
        [104.1, 1.1],
      ],
    });
  });

  it('refuses coordinates outside WGS84 with a [lon, lat] hint', () => {
    const errors = fieldErrors({
      type: 'Point',
      coordinates: [-6.87, 112.72], // [lat, lon] swapped
    });
    expect(errors).toEqual([
      {
        field: 'geometry.coordinates.1',
        message: expect.stringContaining(
          'GeoJSON positions are [longitude, latitude] in WGS84',
        ) as string,
      },
    ]);
    expect(
      fieldErrors({ type: 'Point', coordinates: [181, 0] }).map(
        (error) => error.field,
      ),
    ).toEqual(['geometry.coordinates.0']);
  });

  it('reports structural problems with their paths', () => {
    expect(fieldErrors({ type: 'Circle', coordinates: [0, 0] })).toEqual([
      { field: 'geometry.type', message: expect.any(String) as string },
    ]);
    const openRing = fieldErrors({
      type: 'Polygon',
      coordinates: [
        [
          [104, 1],
          [104.1, 1],
          [104.1, 1.1],
          [104, 1.1],
        ],
      ],
    });
    expect(openRing).toEqual([
      {
        field: 'geometry.coordinates.0',
        message: expect.stringContaining('closed') as string,
      },
    ]);
    expect(
      fieldErrors({ type: 'LineString', coordinates: [[104, 1]] }),
    ).toEqual([
      {
        field: 'geometry.coordinates',
        message: expect.any(String) as string,
      },
    ]);
    expect(fieldErrors('POLYGON((0 0, 1 1))')).toEqual([
      { field: 'geometry', message: expect.any(String) as string },
    ]);
  });

  it('refuses non-finite numbers', () => {
    expect(
      fieldErrors({ type: 'Point', coordinates: [Number.NaN, 1] }),
    ).toHaveLength(1);
  });
});

describe('assertZoneGeometryRules', () => {
  it('defines the allowed geometry types of every zone kind', () => {
    expect(Object.keys(ZONE_GEOMETRY_TYPES).sort()).toEqual(
      [...ZONE_KINDS].sort(),
    );
    expect(ZONE_GEOMETRY_TYPES.pipeline).toEqual([
      'LineString',
      'MultiLineString',
    ]);
    expect(ZONE_GEOMETRY_TYPES.transhipment_area).toEqual([
      'Polygon',
      'MultiPolygon',
    ]);
    expect(ZONE_GEOMETRY_TYPES.custom).toContain('GeometryCollection');
  });

  it('accepts a geometry type the kind allows', () => {
    expect(() => {
      assertZoneGeometryRules('pipeline', LINE, 1750);
    }).not.toThrow();
    expect(() => {
      assertZoneGeometryRules('restricted', SQUARE, 0);
    }).not.toThrow();
  });

  it('refuses a geometry type the kind does not allow (422)', () => {
    const attempt = () => {
      assertZoneGeometryRules('pipeline', SQUARE, 0);
    };
    expect(attempt).toThrow(ZoneGeometryTypeNotAllowedError);
    expect(attempt).toThrow(
      expect.objectContaining({
        status: 422,
        code: 'ZONE_GEOMETRY_TYPE_NOT_ALLOWED',
        extra: {
          kind: 'pipeline',
          geometryType: 'Polygon',
          allowedGeometryTypes: ['LineString', 'MultiLineString'],
        },
      }),
    );
    expect(() => {
      assertZoneGeometryRules('mpa', LINE, 0);
    }).toThrow(ZoneGeometryTypeNotAllowedError);
  });

  it(`accepts ${ZONE_MAX_VERTICES} vertices and refuses one more (422)`, () => {
    expect(() => {
      assertZoneGeometryRules('custom', lineOf(ZONE_MAX_VERTICES), 0);
    }).not.toThrow();
    expect(() => {
      assertZoneGeometryRules('custom', lineOf(ZONE_MAX_VERTICES + 1), 0);
    }).toThrow(
      expect.objectContaining({
        code: 'ZONE_GEOMETRY_TOO_COMPLEX',
        status: 422,
        extra: { vertices: 50_001, maxVertices: 50_000 },
      }),
    );
  });

  it('needs a buffer around point zones', () => {
    const point: ZoneGeometry = { type: 'Point', coordinates: [104, 1] };
    expect(() => {
      assertZoneGeometryRules('anchorage', point, 0);
    }).toThrow(ZoneBufferRequiredError);
    expect(() => {
      assertZoneGeometryRules('anchorage', point, 500);
    }).not.toThrow();
    // A collection with an area is not a point zone.
    expect(() => {
      assertZoneGeometryRules(
        'custom',
        { type: 'GeometryCollection', geometries: [point, SQUARE] },
        0,
      );
    }).not.toThrow();
  });
});

describe('geometry facts', () => {
  it('counts vertices, ring closures included', () => {
    expect(geometryVertexCount(SQUARE)).toBe(5);
    expect(geometryVertexCount(LINE)).toBe(2);
  });

  it('computes the dimension and the bbox', () => {
    expect(
      geometryDimension({ type: 'MultiPoint', coordinates: [[1, 2]] }),
    ).toBe(0);
    expect(geometryDimension(LINE)).toBe(1);
    expect(
      geometryDimension({
        type: 'GeometryCollection',
        geometries: [LINE, SQUARE],
      }),
    ).toBe(2);
    expect(zoneGeometryBBox(SQUARE)).toEqual([104, 1, 104.1, 1.1]);
  });
});

describe('antimeridian rule', () => {
  const crossingRings: [number, number][][] = [
    [
      [179, 0],
      [-179, 0],
      [-179, 1],
      [179, 1],
      [179, 0],
    ],
  ];
  const squareRings: [number, number][][] = [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ];
  const crossingPolygon = {
    type: 'Polygon' as const,
    coordinates: crossingRings,
  };

  it('finds the first edge spanning more than 180 degrees of longitude', () => {
    expect(findAntimeridianCrossing(crossingPolygon)).toEqual({
      from: [179, 0],
      to: [-179, 0],
      path: 'coordinates.0.0',
    });
    expect(
      findAntimeridianCrossing({
        type: 'MultiLineString',
        coordinates: [
          [
            [104, 1],
            [105, 1],
          ],
          [
            [170, 0],
            [175, 0],
            [-175, 0],
          ],
        ],
      }),
    ).toMatchObject({ path: 'coordinates.1.1', from: [175, 0] });
    expect(
      findAntimeridianCrossing({
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'LineString',
            coordinates: [
              [104, 1],
              [105, 1],
            ],
          },
          crossingPolygon,
        ],
      }),
    ).toMatchObject({ path: 'geometries.1.coordinates.0.0' });
    expect(
      findAntimeridianCrossing({
        type: 'MultiPolygon',
        coordinates: [squareRings, crossingRings],
      }),
    ).toMatchObject({ path: 'coordinates.1.0.0' });
  });

  it('accepts geometries split at the antimeridian and long edges up to 180 degrees', () => {
    const split: ZoneGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [179, 0],
            [180, 0],
            [180, 1],
            [179, 1],
            [179, 0],
          ],
        ],
        [
          [
            [-180, 0],
            [-179, 0],
            [-179, 1],
            [-180, 1],
            [-180, 0],
          ],
        ],
      ],
    };
    expect(findAntimeridianCrossing(split)).toBeUndefined();
    expect(
      findAntimeridianCrossing({
        type: 'LineString',
        coordinates: [
          [-90, 0],
          [90, 0],
        ],
      }),
    ).toBeUndefined();
    // Points have no edges.
    expect(
      findAntimeridianCrossing({
        type: 'MultiPoint',
        coordinates: [
          [179.9, 0],
          [-179.9, 0],
        ],
      }),
    ).toBeUndefined();
  });

  it('refuses a crossing geometry with 422 and a splitting hint', () => {
    expect(() => {
      assertNoAntimeridianCrossing(crossingPolygon);
    }).toThrow(
      expect.objectContaining({
        status: 422,
        code: 'ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN',
        detail: expect.stringContaining('spans 358° of longitude') as string,
        extra: {
          from: [179, 0],
          to: [-179, 0],
          path: 'geometry.coordinates.0.0',
        },
      }) as Error,
    );
    expect(() => {
      assertNoAntimeridianCrossing(SQUARE);
    }).not.toThrow();
  });
});
