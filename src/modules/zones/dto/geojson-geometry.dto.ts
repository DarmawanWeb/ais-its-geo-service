import {
  GEOMETRY_TYPES,
  type GeometryType,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * OpenAPI model of a GeoJSON geometry (RFC 7946) in WGS84 degrees. It only
 * documents the shape: requests are validated by the domain rules
 * (`parseZoneGeometry`) with field-level errors, which are more precise
 * than class-validator can express for nested coordinate arrays.
 */
export class GeoJsonGeometryDto {
  @ApiProperty({ enum: GEOMETRY_TYPES, example: 'Polygon' })
  readonly type!: GeometryType;

  @ApiPropertyOptional({
    type: 'array',
    items: {},
    description:
      'Positions [longitude, latitude] (WGS84 degrees) nested as the geometry type requires; absent for GeometryCollection. A third coordinate (altitude) is dropped: zones are 2-D.',
    example: [
      [
        [104, 1],
        [104.1, 1],
        [104.1, 1.1],
        [104, 1.1],
        [104, 1],
      ],
    ],
  })
  readonly coordinates?: unknown[];

  @ApiPropertyOptional({
    type: () => [GeoJsonGeometryDto],
    description: 'Members of a GeometryCollection (no nested collections)',
  })
  readonly geometries?: GeoJsonGeometryDto[];
}
