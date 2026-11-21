import { ZONE_KINDS, type ZoneKind } from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { ZoneGeometry } from '../../../domain/zone-geometry.js';
import {
  toZoneFeature,
  type ZoneFeature,
  type ZoneFeatureProperties,
} from '../../../domain/zone-snapshot.js';
import type { ZoneFeatureSet } from '../zones.service.js';
import { GeoJsonGeometryDto } from './geojson-geometry.dto.js';

/** `properties` of a zone feature. */
export class ZoneFeaturePropertiesDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly orgId: string | null;

  @ApiProperty()
  readonly global: boolean;

  @ApiProperty()
  readonly code: string;

  @ApiProperty()
  readonly name: string;

  @ApiProperty({ enum: ZONE_KINDS })
  readonly kind: ZoneKind;

  @ApiProperty({ description: 'meters' })
  readonly bufferM: number;

  @ApiProperty()
  readonly alertOnEnter: boolean;

  @ApiProperty()
  readonly active: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Kind-specific properties with the provenance (source), e.g. the pipeline KP markers',
  })
  readonly zoneProperties: Record<string, unknown>;

  constructor(properties: ZoneFeatureProperties) {
    this.id = properties.id;
    this.orgId = properties.orgId;
    this.global = properties.global;
    this.code = properties.code;
    this.name = properties.name;
    this.kind = properties.kind;
    this.bufferM = properties.bufferM;
    this.alertOnEnter = properties.alertOnEnter;
    this.active = properties.active;
    this.updatedAt = properties.updatedAt;
    this.zoneProperties = properties.zoneProperties;
  }
}

/** A zone as a GeoJSON Feature (RFC 7946 §3.2). */
export class ZoneFeatureDto {
  @ApiProperty({ enum: ['Feature'] })
  readonly type: 'Feature';

  @ApiProperty({ format: 'uuid', description: 'The zone id' })
  readonly id: string;

  @ApiProperty({ type: GeoJsonGeometryDto })
  readonly geometry: ZoneGeometry;

  @ApiProperty({ type: ZoneFeaturePropertiesDto })
  readonly properties: ZoneFeaturePropertiesDto;

  constructor(feature: ZoneFeature) {
    this.type = feature.type;
    this.id = feature.id;
    this.geometry = feature.geometry;
    this.properties = new ZoneFeaturePropertiesDto(feature.properties);
  }
}

/**
 * `GET /zones/geojson`: a GeoJSON FeatureCollection (RFC 7946 §3.3,
 * `application/geo+json`) for the web map, coordinates rounded to 6
 * decimals (≈ 0.1 m); `truncated` and `limit` are foreign members.
 */
export class ZoneFeatureCollectionDto {
  @ApiProperty({ enum: ['FeatureCollection'] })
  readonly type: 'FeatureCollection';

  @ApiProperty({ type: [ZoneFeatureDto] })
  readonly features: ZoneFeatureDto[];

  @ApiProperty({
    description:
      'true when more zones matched than `limit` (narrow the bbox or the kinds)',
  })
  readonly truncated: boolean;

  @ApiProperty({ description: 'Largest number of features of one response' })
  readonly limit: number;

  constructor(set: ZoneFeatureSet) {
    this.type = 'FeatureCollection';
    this.features = set.zones.map(
      (zone) => new ZoneFeatureDto(toZoneFeature(zone)),
    );
    this.truncated = set.truncated;
    this.limit = set.limit;
  }
}
