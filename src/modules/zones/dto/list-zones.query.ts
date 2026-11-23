import {
  ZONE_KINDS,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { BBoxQueryDto, PageQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  type ValidationArguments,
  ValidateBy,
} from 'class-validator';

import {
  booleanQuery,
  listQuery,
  trimString,
} from '../../../common/transforms.js';
import { MAP_MAX_ZOOM } from '../../../domain/zone-map.js';

/**
 * Refuses `global=true` together with `orgId` (`400 VALIDATION_FAILED`,
 * code `globalWithOrgId`): global zones belong to no organization, so the
 * filter could only ever match nothing.
 */
function NotGlobalWithOrgId(): PropertyDecorator {
  return ValidateBy({
    name: 'globalWithOrgId',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        !(
          value === true &&
          (args?.object as { orgId?: unknown } | undefined)?.orgId !== undefined
        ),
      defaultMessage: () =>
        'global=true cannot be combined with orgId (global zones have no organization)',
    },
  });
}

/** Filters shared by the list and the map endpoints. */
export class ZoneFilterQuery extends BBoxQueryDto {
  @ApiPropertyOptional({
    enum: ZONE_KINDS,
    isArray: true,
    description:
      'One or more kinds, repeated (kind=a&kind=b) or comma separated',
    example: ['pipeline'],
  })
  @IsOptional()
  @Transform(listQuery)
  @IsArray()
  @ArrayMaxSize(ZONE_KINDS.length)
  @IsIn(ZONE_KINDS, { each: true })
  readonly kind?: ZoneKind[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Zones owned by this organization (authority and super_admin: any; others: their own)',
  })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'true = global zones only (shared by every organization); false = organization zones only (within what you may read: your own organization, or every organization for authority and super_admin); both when absent. global=true cannot be combined with orgId',
  })
  @IsOptional()
  @Transform(booleanQuery)
  @IsBoolean()
  @NotGlobalWithOrgId()
  readonly global?: boolean;
}

/** Query of `GET /api/v2/zones` (page-based list, spec §5). */
export class ListZonesQuery extends IntersectionType(
  PageQueryDto,
  ZoneFilterQuery,
) {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only active (true) or inactive (false) zones; both when absent',
  })
  @IsOptional()
  @Transform(booleanQuery)
  @IsBoolean()
  readonly active?: boolean;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the code or the name',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  readonly search?: string;
}

/** Query of `GET /api/v2/zones/geojson` (the map layer). */
export class ZoneGeoJsonQuery extends ZoneFilterQuery {
  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    maximum: MAP_MAX_ZOOM,
    description:
      'Map zoom level: geometries are simplified to half a pixel of it (ST_SimplifyPreserveTopology); full resolution when absent or >= 19',
    example: 9,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAP_MAX_ZOOM)
  readonly zoom?: number;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description:
      'Active zones only (default, what detectors use); false = inactive zones only',
  })
  @IsOptional()
  @Transform(booleanQuery)
  @IsBoolean()
  readonly active: boolean = true;
}
