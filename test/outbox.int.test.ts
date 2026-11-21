import { EVENT_TYPES, subjects } from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from '../src/service.js';
import { idOf, SURABAYA_SQUARE, zoneBody } from './support/fixtures.js';
import {
  collectGeoEvents,
  lastMessage,
  lastZoneMessage,
  subjectCount,
} from './support/geo-stream.js';
import {
  startTestService,
  type TestService,
  USERS,
} from './support/test-service.js';

const ZONES = '/api/v2/zones';

/**
 * The transactional outbox end to end: API change → outbox row → relay →
 * GEO stream (compacted, one message per zone) → consumers.
 */
describe('zone events through the outbox', () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
    await service.reset();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('publishes snapshots and the tombstone of a zone to GEO, in order', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminA,
      body: zoneBody({ name: 'Version 1' }),
    });
    const id = idOf(created);
    const consumer = await collectGeoEvents(service.app, subjects.geoZone(id), [
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      EVENT_TYPES.GEO_ZONE_DELETED,
    ]);
    try {
      const first = await waitFor(() => lastZoneMessage(service.app, id), {
        timeoutMs: 10_000,
      });
      expect(first.envelope).toMatchObject({
        type: EVENT_TYPES.GEO_ZONE_UPSERTED,
        source: SERVICE.name,
        subject: id,
        data: {
          id,
          orgId: USERS.orgAdminA.orgId,
          name: 'Version 1',
          kind: 'restricted',
          geometry: created.json<{ geometry: unknown }>().geometry,
        },
      });
      // Envelope id = outbox row id = Nats-Msg-Id; the relay marks the row
      // published when its transaction commits (just after the ack).
      expect(first.msgId).toBe(first.envelope.id);
      const row = await waitFor(
        async () => {
          const { rows } = await service.pool.query<{
            type: string;
            published_at: Date | null;
          }>('SELECT type, published_at FROM outbox WHERE id = $1', [
            first.envelope.id,
          ]);
          return rows[0]?.published_at === null ? undefined : rows[0];
        },
        { timeoutMs: 10_000 },
      );
      expect(row).toEqual({
        type: EVENT_TYPES.GEO_ZONE_UPSERTED,
        published_at: expect.any(Date) as Date,
      });

      await service.request('PATCH', `${ZONES}/${id}`, {
        user: USERS.orgAdminA,
        body: { name: 'Version 2', geometry: SURABAYA_SQUARE },
      });
      await service.request('DELETE', `${ZONES}/${id}`, {
        user: USERS.orgAdminA,
      });

      const tombstone = await waitFor(
        async () => {
          const last = await lastZoneMessage(service.app, id);
          return last?.envelope.type === EVENT_TYPES.GEO_ZONE_DELETED
            ? last
            : undefined;
        },
        { timeoutMs: 10_000 },
      );
      expect(tombstone.envelope.data).toEqual({
        id,
        orgId: USERS.orgAdminA.orgId,
      });
      // The compacted stream keeps only the latest message of the zone.
      expect(await subjectCount(service.app, 'GEO', subjects.geoZone(id))).toBe(
        1,
      );

      // A consumer that followed the subject saw every change in order.
      await waitFor(() => consumer.events.length >= 3, { timeoutMs: 10_000 });
      expect(
        consumer.events.map((event) =>
          event.type === EVENT_TYPES.GEO_ZONE_UPSERTED
            ? event.data.name
            : 'deleted',
        ),
      ).toEqual(['Version 1', 'Version 2', 'deleted']);
    } finally {
      await consumer.stop();
    }
  });

  it('publishes the audit records of zone changes to AUDIT', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.orgAdminB,
      body: zoneBody(),
    });
    const id = idOf(created);
    const audit = await waitFor(
      async () => {
        const last = await lastMessage(
          service.app,
          'AUDIT',
          subjects.audit(SERVICE.name),
        );
        return last?.envelope.type === EVENT_TYPES.AUDIT_RECORDED &&
          last.envelope.data.targetId === id
          ? last
          : undefined;
      },
      { timeoutMs: 10_000 },
    );
    expect(audit.envelope.data).toMatchObject({
      actorType: 'user',
      orgId: USERS.orgAdminB.orgId,
      action: 'zone.create',
      targetType: 'zone',
      targetId: id,
      meta: { kind: 'restricted' },
    });
  });

  it('republishes every zone for super_admin only', async () => {
    const created = await service.request('POST', ZONES, {
      user: USERS.superAdmin,
      body: zoneBody({ global: true }),
    });
    const id = idOf(created);
    const before = await waitFor(() => lastZoneMessage(service.app, id), {
      timeoutMs: 10_000,
    });

    const authority = await service.request('POST', `${ZONES}/republish`, {
      user: USERS.authority,
    });
    expect(authority.statusCode).toBe(403);
    expect(authority.json()).toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    const viewer = await service.request('POST', `${ZONES}/republish`, {
      user: USERS.viewerA,
    });
    expect(viewer.statusCode).toBe(403);

    const { rows } = await service.pool.query<{ zones: string }>(
      'SELECT count(*) AS zones FROM zones',
    );
    const response = await service.request('POST', `${ZONES}/republish`, {
      user: USERS.superAdmin,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ enqueued: Number(rows[0]?.zones) });

    const after = await waitFor(
      async () => {
        const last = await lastZoneMessage(service.app, id);
        return last !== null && last.seq > before.seq ? last : undefined;
      },
      { timeoutMs: 10_000 },
    );
    expect(after.envelope.id).not.toBe(before.envelope.id);
    expect(after.envelope.data).toEqual(before.envelope.data);
    const republished = await waitFor(
      async () => {
        const last = await lastMessage(
          service.app,
          'AUDIT',
          subjects.audit(SERVICE.name),
        );
        return last?.envelope.type === EVENT_TYPES.AUDIT_RECORDED &&
          last.envelope.data.action === 'zone.republish'
          ? last
          : undefined;
      },
      { timeoutMs: 10_000 },
    );
    expect(republished.envelope.data).toMatchObject({
      actorType: 'user',
      meta: { count: Number(rows[0]?.zones) },
    });
  });

  it('exposes the outbox metrics', async () => {
    await waitFor(
      async () => {
        const { rows } = await service.pool.query<{ pending: string }>(
          'SELECT count(*) AS pending FROM outbox WHERE published_at IS NULL',
        );
        return rows[0]?.pending === '0';
      },
      { timeoutMs: 10_000 },
    );
    const metrics = await service.request('GET', '/metrics');
    expect(metrics.body).toMatch(
      /aisits_outbox_relayed_total\{type="geo\.zone\.upserted\.v1",outcome="published"\} \d+/,
    );
    expect(metrics.body).toContain('aisits_outbox_oldest_pending_seconds');
    expect(metrics.body).toMatch(
      /aisits_geo_zone_changes_total\{kind="restricted",action="create"\} \d+/,
    );
  });
});
