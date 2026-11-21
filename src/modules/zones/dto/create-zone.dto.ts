import {
  ZONE_KINDS,
  ZONE_MAX_VERTICES,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { trimString } from '../../../common/transforms.js';
import { GeoJsonGeometryDto } from './geojson-geometry.dto.js';

/** Zone codes: lowercase slugs such as `mvp-pipeline` or `idbtm.anchorage-a`. */
export const ZONE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Largest zone buffer, meters (100 km). */
export const MAX_BUFFER_M = 100_000;

/** `POST /api/v2/zones`. */
export class CreateZoneDto {
  @ApiProperty({
    description:
      'Stable code, unique among the global zones or within the organization; never changes',
    pattern: ZONE_CODE_PATTERN.source,
    example: 'idbtm-anchorage-a',
  })
  @IsString()
  @Matches(ZONE_CODE_PATTERN, {
    message:
      'code must be a lowercase slug of 1-64 characters (a-z, 0-9, ".", "_", "-")',
  })
  readonly code!: string;

  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Batam anchorage A' })
  @Transform(trimString)
  @IsString()
  @Length(1, 200)
  readonly name!: string;

  @ApiProperty({ enum: ZONE_KINDS, example: 'anchorage' })
  @IsIn(ZONE_KINDS)
  readonly kind!: ZoneKind;

  @ApiProperty({
    type: GeoJsonGeometryDto,
    description: `GeoJSON geometry in WGS84 degrees: the geometry type must fit the kind (pipeline: lines; transhipment_area, fishing_ground, mpa, shallow_water: polygons; restricted, anchorage, port: polygons or points with bufferM > 0; tss_lane: polygons or lines; custom: any), at most ${ZONE_MAX_VERTICES} vertices, valid per PostGIS ST_IsValid (never repaired automatically)`,
  })
  @IsObject()
  readonly geometry!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Buffer around the geometry, meters',
    minimum: 0,
    maximum: MAX_BUFFER_M,
    default: 0,
    example: 500,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_BUFFER_M)
  readonly bufferM?: number;

  @ApiPropertyOptional({
    description: 'Raise geofence alerts when a vessel enters the zone',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  readonly alertOnEnter?: boolean;

  @ApiPropertyOptional({
    description: 'Inactive zones are kept but ignored by detectors and tiles',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  readonly active?: boolean;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Kind-specific properties (contracts ZONE_PROPERTY_SCHEMAS), e.g. pipeline markers [{ name, lat, lon }], shallow_water depthM, port unlocode; unknown keys are kept; at most 64 KiB; "source" is reserved',
    example: { note: 'Designated by the harbour master' },
  })
  @IsOptional()
  @IsObject()
  readonly properties?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Provenance of the geometry (dataset, survey, regulation)',
    maxLength: 500,
    example: 'KSOP Batam notice 12/2026',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 500)
  readonly source?: string;

  @ApiPropertyOptional({
    description:
      'true = global zone shared by every organization (super_admin and authority only); false = zone of the active organization',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  readonly global?: boolean;
}
