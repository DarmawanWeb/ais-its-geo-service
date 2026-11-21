import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { ForbiddenError } from '@darmawanweb/ais-its-nest';
import { UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { describe, expect, it } from 'vitest';

import {
  GlobalZoneWriteForbiddenError,
  OrganizationRequiredError,
  ZoneWriteForbiddenError,
} from '../../domain/zone-errors.js';
import {
  assertOwnerFilter,
  assertZoneWritable,
  ownerOfNewZone,
  readScopeOf,
} from './zone-access.js';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';
const ZONE_ID = '01900000-0000-7000-8000-0000000000c1';

function user(orgId: string | null, ...roles: Role[]): UserPrincipal {
  return new UserPrincipal({
    id: '01900000-0000-7000-8000-0000000000f1',
    sessionId: '01900000-0000-7000-8000-0000000000f2',
    orgId,
    roles,
    email: 'user@example.test',
    name: 'User',
  });
}

describe('readScopeOf', () => {
  it('gives authority and super_admin every zone', () => {
    expect(readScopeOf(user(ORG_A, 'authority'))).toEqual({ kind: 'all' });
    expect(readScopeOf(user(null, 'super_admin'))).toEqual({ kind: 'all' });
  });

  it('gives other roles the global zones and their active organization', () => {
    expect(readScopeOf(user(ORG_A, 'viewer'))).toEqual({
      kind: 'tenant',
      orgId: ORG_A,
    });
    expect(readScopeOf(user(null, 'org_admin'))).toEqual({
      kind: 'tenant',
      orgId: null,
    });
  });
});

describe('ownerOfNewZone', () => {
  it('lets super_admin and authority create global zones only', () => {
    expect(ownerOfNewZone(user(null, 'super_admin'), true)).toBeNull();
    expect(ownerOfNewZone(user(ORG_A, 'authority'), true)).toBeNull();
    expect(() => ownerOfNewZone(user(ORG_A, 'org_admin'), true)).toThrow(
      GlobalZoneWriteForbiddenError,
    );
  });

  it('puts organization zones in the active organization', () => {
    expect(ownerOfNewZone(user(ORG_A, 'org_admin'), false)).toBe(ORG_A);
    expect(ownerOfNewZone(user(ORG_B, 'authority'), false)).toBe(ORG_B);
    expect(() => ownerOfNewZone(user(null, 'super_admin'), false)).toThrow(
      OrganizationRequiredError,
    );
  });
});

describe('assertZoneWritable', () => {
  const globalZone = { id: ZONE_ID, orgId: null };
  const zoneOfA = { id: ZONE_ID, orgId: ORG_A };

  it('reserves global zones to super_admin and authority', () => {
    expect(() => {
      assertZoneWritable(user(null, 'super_admin'), globalZone);
    }).not.toThrow();
    expect(() => {
      assertZoneWritable(user(ORG_B, 'authority'), globalZone);
    }).not.toThrow();
    expect(() => {
      assertZoneWritable(user(ORG_A, 'org_admin'), globalZone);
    }).toThrow(GlobalZoneWriteForbiddenError);
  });

  it('lets an organization change its own zones (and super_admin any)', () => {
    expect(() => {
      assertZoneWritable(user(ORG_A, 'org_admin'), zoneOfA);
    }).not.toThrow();
    expect(() => {
      assertZoneWritable(user(null, 'super_admin'), zoneOfA);
    }).not.toThrow();
    // authority reads every zone but writes only its own organization's.
    expect(() => {
      assertZoneWritable(user(ORG_B, 'authority'), zoneOfA);
    }).toThrow(ZoneWriteForbiddenError);
    expect(() => {
      assertZoneWritable(user(ORG_B, 'org_admin'), zoneOfA);
    }).toThrow(
      expect.objectContaining({ status: 403, code: 'ZONE_WRITE_FORBIDDEN' }),
    );
  });
});

describe('assertOwnerFilter', () => {
  it('allows the own organization, or any for authority/super_admin', () => {
    expect(() => {
      assertOwnerFilter(user(ORG_A, 'viewer'), ORG_A);
    }).not.toThrow();
    expect(() => {
      assertOwnerFilter(user(ORG_A, 'authority'), ORG_B);
    }).not.toThrow();
    expect(() => {
      assertOwnerFilter(user(ORG_A, 'fleet_manager'), ORG_B);
    }).toThrow(ForbiddenError);
  });
});
