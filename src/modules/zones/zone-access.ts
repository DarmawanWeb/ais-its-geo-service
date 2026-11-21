import {
  hasAuthorityAccess,
  isPlatformAdmin,
  type Principal,
} from '@darmawanweb/ais-its-contracts/auth';
import { ForbiddenError } from '@darmawanweb/ais-its-nest';

import type { Zone, ZoneReadScope } from '../../domain/zone.js';
import {
  GlobalZoneWriteForbiddenError,
  OrganizationRequiredError,
  ZoneWriteForbiddenError,
} from '../../domain/zone-errors.js';

/**
 * Tenancy of the zones registry (docs/PLATFORM_SPEC.md §8.5, §13.6), decided
 * from the authenticated principal only — never from organization ids sent
 * by the client:
 * - reads: global zones and the zones of the active organization;
 *   `authority` and `super_admin` read every zone;
 * - global zones (`org_id` NULL) are written by `super_admin` / `authority`;
 * - organization zones are written within the active organization
 *   (`super_admin` may change those of any organization).
 * The `zone:read` / `zone:write` permissions are checked before, by the
 * route guards.
 */

/** The zones a principal may read. */
export function readScopeOf(principal: Principal): ZoneReadScope {
  return hasAuthorityAccess(principal)
    ? { kind: 'all' }
    : { kind: 'tenant', orgId: principal.orgId };
}

/**
 * Owner of a zone the principal creates: `null` (global) when `global` is
 * requested, else the active organization.
 *
 * @throws {GlobalZoneWriteForbiddenError} global zone without `super_admin` / `authority`.
 * @throws {OrganizationRequiredError} organization zone without an active organization.
 */
export function ownerOfNewZone(
  principal: Principal,
  global: boolean,
): string | null {
  if (global) {
    if (!hasAuthorityAccess(principal)) throw new GlobalZoneWriteForbiddenError();
    return null;
  }
  if (principal.orgId === null) throw new OrganizationRequiredError();
  return principal.orgId;
}

/**
 * Throws unless the principal may change or delete `zone` (already known to
 * be visible to it).
 *
 * @throws {GlobalZoneWriteForbiddenError} global zone without `super_admin` / `authority`.
 * @throws {ZoneWriteForbiddenError} zone of another organization.
 */
export function assertZoneWritable(
  principal: Principal,
  zone: Pick<Zone, 'id' | 'orgId'>,
): void {
  if (zone.orgId === null) {
    if (!hasAuthorityAccess(principal)) throw new GlobalZoneWriteForbiddenError();
    return;
  }
  if (isPlatformAdmin(principal)) return;
  if (principal.orgId !== zone.orgId) throw new ZoneWriteForbiddenError(zone.id);
}

/**
 * Throws unless the principal may filter zones by owner `orgId`: users who
 * read every zone may name any organization, others only their own.
 *
 * @throws {ForbiddenError} `403 FORBIDDEN` for another organization.
 */
export function assertOwnerFilter(principal: Principal, orgId: string): void {
  if (hasAuthorityAccess(principal) || principal.orgId === orgId) return;
  throw new ForbiddenError(
    'Zones of other organizations are not visible to you',
    { extra: { orgId } },
  );
}
