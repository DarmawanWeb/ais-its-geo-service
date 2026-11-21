import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

import { trimString } from '../../../common/transforms.js';
import { CreateZoneDto } from './create-zone.dto.js';

/**
 * `PATCH /api/v2/zones/:id`: any subset of the create fields except the
 * code and the owner (a zone never moves between organizations; delete and
 * create instead). `properties` replaces the whole object; `source: null`
 * clears the provenance. Every other field refuses `null`
 * (`skipNullProperties: false`): its column is `NOT NULL`.
 */
export class UpdateZoneDto extends PartialType(
  OmitType(CreateZoneDto, ['code', 'global', 'source'] as const),
  { skipNullProperties: false },
) {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'Provenance of the geometry; null clears it',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 500)
  readonly source?: string | null;
}
