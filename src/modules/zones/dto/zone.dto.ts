import {
  type BBox,
  GEOMETRY_TYPES,
  type GeometryType,
  ZONE_KINDS,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { Zone, ZoneSummary } from '../../../domain/zone.js';
import {
  geometryVertexCount,
  type ZoneGeometry,
  zoneGeometryBBox,
} from '../../../domain/zone-geometry.js';
import { GeoJsonGeometryDto } from './geojson-geometry.dto.js';

/** A zone without its geometry (lists); dates as ISO-8601 UTC strings (spec §2). */
export class ZoneSummaryDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Owning organization; null = global zone',
  })
  readonly orgId: string | null;

  @ApiProperty({ description: 'true when orgId is null (shared by every tenant)' })
  readonly global: boolean;

  @ApiProperty({ example: 'mvp-pipeline' })
  readonly code: string;

  @ApiProperty({ example: 'Subsea pipeline (MVP dataset)' })
  readonly name: string;

  @ApiProperty({ enum: ZONE_KINDS })
  readonly kind: ZoneKind;

  @ApiProperty({ description: 'Buffer around the geometry, meters', example: 1750 })
  readonly bufferM: number;

  @ApiProperty()
  readonly alertOnEnter: boolean;

  @ApiProperty()
  readonly active: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Kind-specific properties (contracts ZONE_PROPERTY_SCHEMAS)',
  })
  readonly properties: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Provenance of the geometry',
  })
  readonly source: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Creating user; null for seeds',
  })
  readonly createdBy: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  @ApiProperty({ enum: GEOMETRY_TYPES })
  readonly geometryType: GeometryType;

  @ApiProperty({ description: 'Number of positions, ring closures included' })
  readonly vertexCount: number;

  @ApiProperty({
    type: [Number],
    minItems: 4,
    maxItems: 4,
    description: '[minLon, minLat, maxLon, maxLat] of the geometry',
    example: [112.651, -7.144, 112.719, -6.854],
  })
  readonly bbox: number[];

  constructor(zone: ZoneSummary) {
    this.id = zone.id;
    this.orgId = zone.orgId;
    this.global = zone.orgId === null;
    this.code = zone.code;
    this.name = zone.name;
    this.kind = zone.kind;
    this.bufferM = zone.bufferM;
    this.alertOnEnter = zone.alertOnEnter;
    this.active = zone.active;
    this.properties = { ...zone.properties };
    this.source = zone.source;
    this.createdBy = zone.createdBy;
    this.createdAt = zone.createdAt.toISOString();
    this.updatedAt = zone.updatedAt.toISOString();
    this.geometryType = zone.geometryType;
    this.vertexCount = zone.vertexCount;
    this.bbox = [...zone.bbox];
  }
}

/** A zone with its GeoJSON geometry (`GET /zones/:id`, writes). */
export class ZoneDto extends ZoneSummaryDto {
  @ApiProperty({ type: GeoJsonGeometryDto })
  readonly geometry: ZoneGeometry;

  constructor(zone: Zone) {
    const bbox: BBox = zoneGeometryBBox(zone.geometry);
    super({
      ...zone,
      geometryType: zone.geometry.type,
      vertexCount: geometryVertexCount(zone.geometry),
      bbox,
    });
    this.geometry = zone.geometry;
  }
}

/** `POST /zones/republish`. */
export class RepublishResultDto {
  @ApiProperty({ description: 'Zone snapshots enqueued in the outbox' })
  readonly enqueued: number;

  constructor(enqueued: number) {
    this.enqueued = enqueued;
  }
}
