import type { ProblemDetails } from '@darmawanweb/ais-its-contracts/api';
import {
  GEOMETRY_TYPES,
  type GeometryType,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, getSchemaPath, PickType } from '@nestjs/swagger';

import {
  geometryVertexCount,
  type ZoneGeometry,
  zoneGeometryBBox,
} from '../../../domain/zone-geometry.js';
import { CreateZoneDto } from './create-zone.dto.js';

/**
 * `POST /api/v2/zones/validate`: the fields the input rules read, with the
 * validation and defaults of `POST /zones` (`bufferM` 0, `properties` `{}`).
 */
export class ValidateZoneDto extends PickType(CreateZoneDto, [
  'kind',
  'geometry',
  'bufferM',
  'properties',
] as const) {}

/** Result of `POST /api/v2/zones/validate` (nothing is stored or published). */
export class ZoneValidationDto {
  @ApiProperty({
    description:
      'true when the draft passes every input rule checked here (README steps 2-8); it may still be refused by the write for its owner, quota, code, If-Match or snapshot size',
  })
  readonly valid: boolean;

  @ApiProperty({
    nullable: true,
    allOf: [{ $ref: getSchemaPath('ProblemDetails') }],
    description:
      'The problem details POST /zones would answer for this draft: the first rule it breaks, cheapest first. 400 VALIDATION_FAILED with errors on geometry.* (structure, WGS84 bounds) or properties.*; 422 ZONE_GEOMETRY_TYPE_NOT_ALLOWED, ZONE_GEOMETRY_TOO_COMPLEX, ZONE_BUFFER_REQUIRED, ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN (from, to, path) or ZONE_GEOMETRY_INVALID (reason and location [lon, lat] of PostGIS ST_IsValidDetail, e.g. a self-intersection). null when valid',
  })
  readonly problem: ProblemDetails | null;

  @ApiProperty({
    enum: GEOMETRY_TYPES,
    nullable: true,
    description:
      'Type of the parsed geometry; null when its GeoJSON structure is invalid',
  })
  readonly geometryType: GeometryType | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Positions of the parsed geometry, ring closures included (the count the 50 000-vertex limit applies to); null when its structure is invalid',
  })
  readonly vertexCount: number | null;

  @ApiProperty({
    type: [Number],
    nullable: true,
    minItems: 4,
    maxItems: 4,
    description:
      '[minLon, minLat, maxLon, maxLat] of the parsed geometry; null when its structure is invalid',
    example: [104, 1, 104.1, 1.1],
  })
  readonly bbox: number[] | null;

  /**
   * @param geometry - the parsed geometry, `null` when it did not parse.
   * @param problem - the problem details of the first broken rule, or `null`.
   */
  constructor(geometry: ZoneGeometry | null, problem: ProblemDetails | null) {
    this.valid = problem === null;
    this.problem = problem;
    this.geometryType = geometry?.type ?? null;
    this.vertexCount = geometry === null ? null : geometryVertexCount(geometry);
    this.bbox = geometry === null ? null : [...zoneGeometryBBox(geometry)];
  }
}
