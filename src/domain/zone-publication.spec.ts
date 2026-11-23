import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { EventTooLargeError } from '@darmawanweb/ais-its-nest/nats';
import { describe, expect, it } from 'vitest';

import { ZoneSnapshotTooLargeError } from './zone-errors.js';
import {
  NATS_DEFAULT_MAX_PAYLOAD_BYTES,
  worstCaseSnapshotPayloadBytes,
  zonePublicationError,
} from './zone-publication.js';

describe('zonePublicationError', () => {
  it('maps the kit EventTooLargeError to 422 ZONE_SNAPSHOT_TOO_LARGE', () => {
    const tooLarge = new EventTooLargeError(
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      1_300_000,
      1_048_576,
    );
    const mapped = zonePublicationError(tooLarge);
    expect(mapped).toBeInstanceOf(ZoneSnapshotTooLargeError);
    expect(mapped).toMatchObject({
      status: 422,
      code: 'ZONE_SNAPSHOT_TOO_LARGE',
      extra: { snapshotBytes: 1_300_000, maxBytes: 1_048_576 },
      cause: tooLarge,
    });
  });

  it('returns any other error unchanged', () => {
    const other = new Error('connection terminated');
    expect(zonePublicationError(other)).toBe(other);
  });
});

describe('worstCaseSnapshotPayloadBytes', () => {
  it('exceeds the 1 MiB NATS default and fits the platform 4 MB', () => {
    const bytes = worstCaseSnapshotPayloadBytes();
    expect(bytes).toBeGreaterThan(NATS_DEFAULT_MAX_PAYLOAD_BYTES);
    expect(bytes).toBeGreaterThan(1_500_000);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });

  it('measures the encoded envelope, whose source is part of it', () => {
    const short = worstCaseSnapshotPayloadBytes('geo');
    const long = worstCaseSnapshotPayloadBytes('geo-replica-b');
    expect(long - short).toBe('geo-replica-b'.length - 'geo'.length);
  });
});
