import {
  ZONE_KINDS,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { ZoneGeometry } from '../../../domain/zone-geometry.js';
import { GeoJsonGeometryDto } from './geojson-geometry.dto.js';

/** `properties` of a zone feature (`zoneFeatureProperties` in `domain/zone-snapshot.ts`). */
export class ZoneFeaturePropertiesDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly orgId!: string | null;

  @ApiProperty()
  readonly global!: boolean;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: ZONE_KINDS })
  readonly kind!: ZoneKind;

  @ApiProperty({ description: 'meters' })
  readonly bufferM!: number;

  @ApiProperty()
  readonly alertOnEnter!: boolean;

  @ApiProperty()
  readonly active!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Kind-specific properties with the provenance (source), e.g. the pipeline KP markers',
  })
  readonly zoneProperties!: Record<string, unknown>;
}

/** A zone as a GeoJSON Feature (RFC 7946 §3.2). */
export class ZoneFeatureDto {
  @ApiProperty({ enum: ['Feature'] })
  readonly type!: 'Feature';

  @ApiProperty({ format: 'uuid', description: 'The zone id' })
  readonly id!: string;

  @ApiProperty({ type: GeoJsonGeometryDto })
  readonly geometry!: ZoneGeometry;

  @ApiProperty({ type: ZoneFeaturePropertiesDto })
  readonly properties!: ZoneFeaturePropertiesDto;
}

/**
 * `GET /zones/geojson`: a GeoJSON FeatureCollection (RFC 7946 §3.3,
 * `application/geo+json`) for the web map, geometries simplified for the
 * zoom and rounded to 6 decimals (≈ 0.1 m). The members after `features`
 * are foreign members describing the budgets. The response is streamed by
 * `featureCollectionJson` (`domain/zone-map.ts`); this class documents it.
 */
export class ZoneFeatureCollectionDto {
  @ApiProperty({ enum: ['FeatureCollection'] })
  readonly type!: 'FeatureCollection';

  @ApiProperty({ type: [ZoneFeatureDto] })
  readonly features!: ZoneFeatureDto[];

  @ApiProperty({
    description:
      'true when more zones matched than the budgets allow (zoom out with `zoom`, narrow the bbox or the kinds)',
  })
  readonly truncated!: boolean;

  @ApiProperty({
    type: String,
    enum: ['features', 'vertices'],
    nullable: true,
    description: 'The budget that cut the response; null when complete',
  })
  readonly truncatedBy!: 'features' | 'vertices' | null;

  @ApiProperty({
    description:
      'Largest number of features of one response (ZONES_GEOJSON_MAX_FEATURES)',
  })
  readonly limit!: number;

  @ApiProperty({
    description:
      'Largest number of vertices of one response, after simplification (ZONES_GEOJSON_MAX_VERTICES)',
  })
  readonly vertexLimit!: number;

  @ApiProperty({ description: 'Features in this response' })
  readonly featureCount!: number;

  @ApiProperty({
    description: 'Vertices in this response (after simplification)',
  })
  readonly vertexCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The requested zoom level; null = full resolution',
  })
  readonly zoom!: number | null;

  @ApiProperty({
    description: 'Simplification tolerance applied, degrees (0 = none)',
  })
  readonly toleranceDeg!: number;
}
