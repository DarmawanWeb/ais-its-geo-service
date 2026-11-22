import {
  encodeEnvelope,
  EVENT_TYPES,
  makeEnvelope,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  assertPublishable,
  EVENT_HEADER_ALLOWANCE_BYTES,
  encodedSnapshotBytes,
  maxEnvelopeBytes,
  NATS_DEFAULT_MAX_PAYLOAD_BYTES,
  worstCaseSnapshotPayloadBytes,
} from './zone-publication.js';

const SNAPSHOT: ZoneSnapshotV1 = {
  id: '01900000-0000-7000-8000-000000000001',
  orgId: null,
  code: 'z',
  name: 'Zone',
  kind: 'restricted',
  geometry: { type: 'Point', coordinates: [104, 1] },
  bufferM: 500,
  active: true,
  alertOnEnter: false,
  properties: {},
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('encodedSnapshotBytes', () => {
  it('measures the envelope the publisher sends, traceparent included', () => {
    const plain = encodeEnvelope(
      makeEnvelope({
        type: EVENT_TYPES.GEO_ZONE_UPSERTED,
        source: 'geo',
        data: SNAPSHOT,
      }),
    ).byteLength;
    // ,"traceparent":"<55 characters>"
    expect(encodedSnapshotBytes(SNAPSHOT, 'geo')).toBe(plain + 72);
  });

  it('grows with the geometry', () => {
    const line: ZoneSnapshotV1 = {
      ...SNAPSHOT,
      kind: 'pipeline',
      geometry: {
        type: 'LineString',
        coordinates: [
          [104.123456789, 1.123456789],
          [104.2, 1.2],
        ],
      },
    };
    expect(encodedSnapshotBytes(line, 'geo')).toBeGreaterThan(
      encodedSnapshotBytes(SNAPSHOT, 'geo'),
    );
  });
});

describe('assertPublishable', () => {
  it('keeps the header allowance out of the server limit', () => {
    expect(maxEnvelopeBytes(4096)).toBe(4096 - EVENT_HEADER_ALLOWANCE_BYTES);
    expect(maxEnvelopeBytes(100)).toBe(0);
    expect(() => {
      assertPublishable(3072, 4096);
    }).not.toThrow();
  });

  it('refuses a larger envelope with 422 ZONE_SNAPSHOT_TOO_LARGE', () => {
    expect(() => {
      assertPublishable(3073, 4096);
    }).toThrow(
      expect.objectContaining({
        status: 422,
        code: 'ZONE_SNAPSHOT_TOO_LARGE',
        extra: { snapshotBytes: 3073, maxBytes: 3072 },
      }) as Error,
    );
  });
});

describe('worstCaseSnapshotPayloadBytes', () => {
  it('exceeds the 1 MiB NATS default and fits the platform 4 MB', () => {
    const bytes = worstCaseSnapshotPayloadBytes();
    expect(bytes).toBeGreaterThan(NATS_DEFAULT_MAX_PAYLOAD_BYTES);
    expect(bytes).toBeGreaterThan(1_500_000);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });
});
