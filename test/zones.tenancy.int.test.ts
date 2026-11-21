import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idOf, zoneBody } from './support/fixtures.js';
import {
  ORG_A,
  ORG_B,
  startTestService,
  type TestService,
  type TestUser,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';

interface Summary {
  id: string;
  orgId: string | null;
  code: string;
}

/**
 * Tenancy of spec §8.5 / §13.6: global zones are shared and written by
 * super_admin/authority; organization zones are private to their
 * organization (read by authority/super_admin) and written within it.
 */
describe('zones tenancy', () => {
  let service: TestService;
  const ids: Record<string, string> = {};

  /** Ids of the zones a user sees in the list. */
  async function visibleIds(user: TestUser, query = ''): Promise<string[]> {
    const response = await service.request(
      'GET',
      `${ZONES}?pageSize=100${query}`,
      { user },
    );
    expect(response.statusCode).toBe(200);
    return response
      .json<{ data: Summary[] }>()
      .data.map((zone) => zone.id)
      .sort();
  }

  beforeAll(async () => {
    service = await startTestService();
    await service.reset();
    const create = async (key: string, user: TestUser, global = false) => {
      const response = await service.request('POST', ZONES, {
        user,
        body: zoneBody({ code: `tenancy-${key}`, global }),
      });
      expect(response.statusCode).toBe(201);
      ids[key] = idOf(response);
    };
    await create('global-admin', USERS.superAdmin, true);
    await create('global-authority', USERS.authority, true);
    await create('org-a', USERS.orgAdminA);
    await create('org-b', USERS.orgAdminB);
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('stores global zones without an owner and org zones in the active organization', async () => {
    const global = await service.request(
      'GET',
      `${ZONES}/${ids['global-authority'] ?? ''}`,
      {
        user: USERS.viewerA,
      },
    );
    expect(global.json()).toMatchObject({ orgId: null, global: true });
    const orgZone = await service.request(
      'GET',
      `${ZONES}/${ids['org-a'] ?? ''}`,
      {
        user: USERS.viewerA,
      },
    );
    expect(orgZone.json()).toMatchObject({ orgId: ORG_A, global: false });
  });

  it('refuses global zones from org admins (403)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ global: true }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'GLOBAL_ZONE_WRITE_FORBIDDEN',
    });
  });

  it('needs an active organization for organization zones (403)', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.superAdmin,
      body: zoneBody(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ORGANIZATION_REQUIRED' });
  });

  it('shows global zones and the own organization zones to org users', async () => {
    const globalIds = [ids['global-admin'], ids['global-authority']];
    expect(await visibleIds(USERS.viewerA)).toEqual(
      [...globalIds, ids['org-a']].sort(),
    );
    expect(await visibleIds(USERS.viewerB)).toEqual(
      [...globalIds, ids['org-b']].sort(),
    );
    const noOrg = await visibleIds({ roles: ['viewer'], orgId: null });
    expect(noOrg).toEqual([...globalIds].sort());
  });

  it('shows every zone to authority and super_admin', async () => {
    const all = Object.values(ids).sort();
    expect(await visibleIds(USERS.authority)).toEqual(all);
    expect(await visibleIds(USERS.superAdmin)).toEqual(all);
    expect(await visibleIds(USERS.authority, `&orgId=${ORG_B}`)).toEqual([
      ids['org-b'],
    ]);
  });

  it('hides other organizations: 404 on read, 403 on an owner filter', async () => {
    const read = await service.request(
      'GET',
      `${ZONES}/${ids['org-a'] ?? ''}`,
      {
        user: USERS.viewerB,
      },
    );
    expect(read.statusCode).toBe(404);
    const filter = await service.request('GET', `${ZONES}?orgId=${ORG_A}`, {
      user: USERS.viewerB,
    });
    expect(filter.statusCode).toBe(403);
    const geojson = await service.request('GET', `${ZONES}/geojson`, {
      user: USERS.viewerB,
    });
    const featureIds = geojson
      .json<{ features: { id: string }[] }>()
      .features.map((feature) => feature.id);
    expect(featureIds).not.toContain(ids['org-a']);
    expect(featureIds).toContain(ids['org-b']);
  });

  it('lets only the owner organization (and super_admin) change org zones', async () => {
    const orgZone = `${ZONES}/${ids['org-a'] ?? ''}`;
    const otherOrg = await service.request('PATCH', orgZone, {
      user: USERS.orgAdminB,
      body: { name: 'hijacked' },
    });
    expect(otherOrg.statusCode).toBe(404);
    const authority = await service.request('PATCH', orgZone, {
      user: USERS.authority,
      body: { name: 'by authority' },
    });
    expect(authority.statusCode).toBe(403);
    expect(authority.json()).toMatchObject({ code: 'ZONE_WRITE_FORBIDDEN' });
    const owner = await service.request('PATCH', orgZone, {
      user: USERS.orgAdminA,
      body: { name: 'by owner' },
    });
    expect(owner.statusCode).toBe(200);
    const admin = await service.request('PATCH', orgZone, {
      user: USERS.superAdmin,
      body: { name: 'by super admin' },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({
      orgId: ORG_A,
      name: 'by super admin',
    });
  });

  it('lets only super_admin and authority change or delete global zones', async () => {
    const globalZone = `${ZONES}/${ids['global-admin'] ?? ''}`;
    const orgAdmin = await service.request('PATCH', globalZone, {
      user: USERS.orgAdminA,
      body: { active: false },
    });
    expect(orgAdmin.statusCode).toBe(403);
    expect(orgAdmin.json()).toMatchObject({
      code: 'GLOBAL_ZONE_WRITE_FORBIDDEN',
    });
    const orgDelete = await service.request('DELETE', globalZone, {
      user: USERS.orgAdminB,
    });
    expect(orgDelete.statusCode).toBe(403);
    const authority = await service.request('PATCH', globalZone, {
      user: USERS.authority,
      body: { active: false },
    });
    expect(authority.statusCode).toBe(200);
    expect(authority.json()).toMatchObject({ active: false, orgId: null });
  });

  it('never takes the owner from the request body', async () => {
    const response = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: { ...zoneBody(), orgId: ORG_B },
    });
    expect(response.statusCode).toBe(400);
  });
});
