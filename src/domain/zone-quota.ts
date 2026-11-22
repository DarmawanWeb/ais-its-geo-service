import { ZoneQuotaExceededError } from './zone-errors.js';

/**
 * Capacity quotas of the registry. Every owner — each organization, and the
 * global namespace (`org_id` NULL) as one owner — may hold at most
 * `maxZones` zones with at most `maxVertices` vertices in total, so one
 * tenant cannot grow the map layer, the `GEO` stream and the detectors'
 * in-memory zone indexes for everyone. Operators size them with
 * `ZONE_QUOTA_MAX_ZONES` / `ZONE_QUOTA_MAX_VERTICES`.
 *
 * Methodology: a platform capacity rule, not an analytic method (no catalog id).
 */

/** Limits per owner. */
export interface ZoneQuota {
  readonly maxZones: number;
  readonly maxVertices: number;
}

/** What an owner holds, or what a write adds to it. */
export interface ZoneUsage {
  readonly zones: number;
  readonly vertices: number;
}

/**
 * Throws when `usage + change` exceeds the quota. A change that does not
 * grow a resource (e.g. a simpler geometry) is always allowed, even for an
 * owner already over a lowered quota.
 *
 * @param orgId - the owner, for the problem details (`null` = global zones).
 * @throws {ZoneQuotaExceededError} `409 ZONE_QUOTA_EXCEEDED`
 */
export function assertZoneQuota(
  usage: ZoneUsage,
  change: ZoneUsage,
  quota: ZoneQuota,
  orgId: string | null,
): void {
  if (change.zones > 0 && usage.zones + change.zones > quota.maxZones) {
    throw new ZoneQuotaExceededError(
      'zones',
      orgId,
      usage.zones,
      change.zones,
      quota.maxZones,
    );
  }
  if (
    change.vertices > 0 &&
    usage.vertices + change.vertices > quota.maxVertices
  ) {
    throw new ZoneQuotaExceededError(
      'vertices',
      orgId,
      usage.vertices,
      change.vertices,
      quota.maxVertices,
    );
  }
}
