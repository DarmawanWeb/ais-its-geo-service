import type {
  ZoneDeletedV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';

import type { Zone } from './zone.js';
import type { ZoneGeometry } from './zone-geometry.js';

/**
 * The published state of a zone: `geo.zone.upserted.v1` (`ZoneSnapshotV1`)
 * on `geo.zone.v1.<zoneId>` of the compacted `GEO` stream, which keeps one
 * message per zone. The provenance column `source` travels as
 * `properties.source` (contracts zone property schemas).
 */
export function toZoneSnapshot(zone: Zone): ZoneSnapshotV1 {
  return {
    id: zone.id,
    orgId: zone.orgId,
    code: zone.code,
    name: zone.name,
    kind: zone.kind,
    geometry: zone.geometry,
    bufferM: zone.bufferM,
    active: zone.active,
    alertOnEnter: zone.alertOnEnter,
    properties: snapshotProperties(zone),
    updatedAt: zone.updatedAt.toISOString(),
  };
}

/** The kind-specific properties with the provenance merged in. */
export function snapshotProperties(
  zone: Pick<Zone, 'properties' | 'source'>,
): Record<string, unknown> {
  return zone.source === null
    ? { ...zone.properties }
    : { ...zone.properties, source: zone.source };
}

/**
 * The tombstone of a deleted zone: `geo.zone.deleted.v1` (`ZoneDeletedV1`)
 * on the zone's subject, so it replaces the last snapshot in `GEO` and
 * consumers drop the zone from their projections.
 */
export function toZoneTombstone(
  zone: Pick<Zone, 'id' | 'orgId'>,
): ZoneDeletedV1 {
  return { id: zone.id, orgId: zone.orgId };
}

/** Properties of a zone feature of the map FeatureCollection. */
export interface ZoneFeatureProperties {
  readonly id: string;
  readonly orgId: string | null;
  readonly global: boolean;
  readonly code: string;
  readonly name: string;
  readonly kind: Zone['kind'];
  readonly bufferM: number;
  readonly alertOnEnter: boolean;
  readonly active: boolean;
  readonly updatedAt: string;
  /** Kind-specific properties with the provenance (e.g. pipeline KP markers). */
  readonly zoneProperties: Record<string, unknown>;
}

/** A zone as a GeoJSON Feature (RFC 7946 §3.2) with the zone id as feature id. */
export interface ZoneFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: ZoneGeometry;
  readonly properties: ZoneFeatureProperties;
}

/** The zone fields of a map feature (everything but the geometry). */
export type ZoneFeatureSource = Omit<
  Zone,
  'geometry' | 'createdBy' | 'createdAt'
>;

/** The `properties` of the map Feature of a zone. */
export function zoneFeatureProperties(
  zone: ZoneFeatureSource,
): ZoneFeatureProperties {
  return {
    id: zone.id,
    orgId: zone.orgId,
    global: zone.orgId === null,
    code: zone.code,
    name: zone.name,
    kind: zone.kind,
    bufferM: zone.bufferM,
    alertOnEnter: zone.alertOnEnter,
    active: zone.active,
    updatedAt: zone.updatedAt.toISOString(),
    zoneProperties: snapshotProperties(zone),
  };
}

/** Maps a zone to the Feature of `GET /api/v2/zones/geojson`. */
export function toZoneFeature(zone: Zone): ZoneFeature {
  return {
    type: 'Feature',
    id: zone.id,
    geometry: zone.geometry,
    properties: zoneFeatureProperties(zone),
  };
}
