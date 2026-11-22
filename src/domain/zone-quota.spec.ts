import { describe, expect, it } from 'vitest';

import { assertZoneQuota } from './zone-quota.js';

const QUOTA = { maxZones: 3, maxVertices: 100 };
const ORG = '01900000-0000-7000-8000-00000000000a';

describe('assertZoneQuota', () => {
  it('allows changes up to the quota, the limit included', () => {
    expect(() => {
      assertZoneQuota(
        { zones: 2, vertices: 50 },
        { zones: 1, vertices: 50 },
        QUOTA,
        ORG,
      );
    }).not.toThrow();
  });

  it('refuses one zone too many with 409 ZONE_QUOTA_EXCEEDED', () => {
    expect(() => {
      assertZoneQuota(
        { zones: 3, vertices: 10 },
        { zones: 1, vertices: 5 },
        QUOTA,
        ORG,
      );
    }).toThrow(
      expect.objectContaining({
        status: 409,
        code: 'ZONE_QUOTA_EXCEEDED',
        extra: {
          resource: 'zones',
          orgId: ORG,
          used: 3,
          requested: 1,
          limit: 3,
        },
      }) as Error,
    );
  });

  it('refuses vertices beyond the quota, for global zones too', () => {
    expect(() => {
      assertZoneQuota(
        { zones: 1, vertices: 90 },
        { zones: 0, vertices: 11 },
        QUOTA,
        null,
      );
    }).toThrow(
      expect.objectContaining({
        code: 'ZONE_QUOTA_EXCEEDED',
        detail: expect.stringContaining('The global zones') as string,
        extra: expect.objectContaining({
          resource: 'vertices',
          orgId: null,
        }) as Record<string, unknown>,
      }) as Error,
    );
  });

  it('always allows changes that do not grow, even over a lowered quota', () => {
    expect(() => {
      assertZoneQuota(
        { zones: 9, vertices: 900 },
        { zones: 0, vertices: -100 },
        QUOTA,
        ORG,
      );
    }).not.toThrow();
  });
});
