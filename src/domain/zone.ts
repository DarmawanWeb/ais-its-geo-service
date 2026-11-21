import type {
  BBox,
  GeometryType,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';

import type { ZoneGeometry } from './zone-geometry.js';

/** A zone (geofence) of the registry, as stored (spec §13.6 table `zones`). */
export interface Zone {
  readonly id: string;
  /** Owning organization; `null` = global zone shared by every tenant. */
  readonly orgId: string | null;
  /** Stable lowercase code, unique per owner (seeds are idempotent by code). */
  readonly code: string;
  readonly name: string;
  readonly kind: ZoneKind;
  /** WGS84, 2-D, as stored by PostGIS. */
  readonly geometry: ZoneGeometry;
  /** Buffer around the geometry, meters. */
  readonly bufferM: number;
  readonly alertOnEnter: boolean;
  /** Inactive zones are kept but ignored by the detectors and the tiles. */
  readonly active: boolean;
  /** Kind-specific properties (contracts `ZONE_PROPERTY_SCHEMAS`). */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Provenance of the geometry; `null` when unknown. */
  readonly source: string | null;
  /** Creating user; `null` for seeds and other system writes. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A zone without its geometry, for lists (geometry facts computed by PostGIS). */
export interface ZoneSummary extends Omit<Zone, 'geometry'> {
  readonly geometryType: GeometryType;
  readonly vertexCount: number;
  readonly bbox: BBox;
}

/** The fields a zone is created with (validated). */
export interface ZoneDraft {
  readonly orgId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: ZoneKind;
  readonly geometry: ZoneGeometry;
  readonly bufferM: number;
  readonly alertOnEnter: boolean;
  readonly active: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly source: string | null;
  readonly createdBy: string | null;
}

/** The fields an update may change (`undefined` = keep). */
export interface ZoneChanges {
  readonly name?: string | undefined;
  readonly kind?: ZoneKind | undefined;
  readonly geometry?: ZoneGeometry | undefined;
  readonly bufferM?: number | undefined;
  readonly alertOnEnter?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
  /** `null` clears the provenance. */
  readonly source?: string | null | undefined;
}

/**
 * Which zones a principal may read (spec §8.5): global zones are shared,
 * organization zones are tenant-private except for `authority` and
 * `super_admin`, who read every zone.
 */
export type ZoneReadScope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'tenant';
      /** Active organization; `null` = global zones only. */
      readonly orgId: string | null;
    };

/** Filters of zone queries. */
export interface ZoneFilter {
  /** Any of these kinds (all kinds when absent or empty). */
  readonly kinds?: readonly ZoneKind[] | undefined;
  readonly active?: boolean | undefined;
  /** Zones whose geometry intersects `[minLon, minLat, maxLon, maxLat]` (lon/lat space). */
  readonly bbox?: BBox | undefined;
  /** Zones owned by this organization. */
  readonly orgId?: string | undefined;
  /** Case-insensitive substring of the code or the name. */
  readonly search?: string | undefined;
}
