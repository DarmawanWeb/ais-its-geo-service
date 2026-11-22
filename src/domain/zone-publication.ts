import { ZONE_MAX_VERTICES } from '@darmawanweb/ais-its-contracts/domain';
import {
  encodeEnvelope,
  EVENT_TYPES,
  makeEnvelope,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';

import { ZoneSnapshotTooLargeError } from './zone-errors.js';
import { ZONE_PROPERTIES_MAX_BYTES } from './zone-properties.js';

/**
 * Publication budget of zone events. NATS refuses messages larger than the
 * server's `max_payload` (headers included; 1 MiB by default, 4 MB on the
 * platform server), and the relay can only mark such an outbox row failed:
 * the zone would be stored and mapped but never reach the detectors. The
 * service therefore measures the encoded event of every change before it
 * commits and refuses what can never be published.
 */

/** `max_payload` of a NATS server started without configuration, bytes. */
export const NATS_DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Bytes kept for the NATS headers of an event (`Nats-Msg-Id`,
 * `content-type`, `Ais-Its-Event-Type`, `traceparent`, framing): about 200
 * in practice, 1 KiB is a safe margin.
 */
export const EVENT_HEADER_ALLOWANCE_BYTES = 1024;

/** A W3C `traceparent` of full length, as the publisher may add it. */
const TRACEPARENT_PLACEHOLDER =
  '00-00000000000000000000000000000000-0000000000000000-00';

/**
 * Size in bytes of the JSON envelope the relay publishes for a zone
 * snapshot (`geo.zone.upserted.v1`; contracts `makeEnvelope` +
 * `encodeEnvelope`, with a full-length `traceparent`), without the NATS
 * headers.
 */
export function encodedSnapshotBytes(
  snapshot: ZoneSnapshotV1,
  source: string,
): number {
  return encodeEnvelope(
    makeEnvelope({
      type: EVENT_TYPES.GEO_ZONE_UPSERTED,
      source,
      data: snapshot,
      traceparent: TRACEPARENT_PLACEHOLDER,
    }),
  ).byteLength;
}

/** Largest envelope a server with this `max_payload` accepts (headers deducted). */
export function maxEnvelopeBytes(maxPayloadBytes: number): number {
  return Math.max(0, maxPayloadBytes - EVENT_HEADER_ALLOWANCE_BYTES);
}

/**
 * Throws when the encoded snapshot cannot be published under the server's
 * `max_payload`.
 *
 * @throws {ZoneSnapshotTooLargeError} `422 ZONE_SNAPSHOT_TOO_LARGE`
 */
export function assertPublishable(
  envelopeBytes: number,
  maxPayloadBytes: number,
): void {
  const limit = maxEnvelopeBytes(maxPayloadBytes);
  if (envelopeBytes > limit) {
    throw new ZoneSnapshotTooLargeError(envelopeBytes, limit);
  }
}

/** The widest position the registry stores: 9 decimals, negative, 3-digit longitude. */
const WIDEST_POSITION: [number, number] = [-179.123456789, -89.123456789];

/**
 * Size of the largest snapshot the input rules allow — {@link ZONE_MAX_VERTICES}
 * positions of maximal width (9 decimals as stored) and properties of
 * {@link ZONE_PROPERTIES_MAX_BYTES} with a 500-character `source` — plus
 * the header allowance: the
 * `max_payload` a NATS server needs so that every valid zone can be
 * published (about 1.6 MB).
 */
export function worstCaseSnapshotPayloadBytes(source = 'geo'): number {
  const snapshot: ZoneSnapshotV1 = {
    id: '01900000-0000-7000-8000-000000000000',
    orgId: '01900000-0000-7000-8000-000000000001',
    code: 'x'.repeat(64),
    name: 'x'.repeat(200),
    kind: 'custom',
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: ZONE_MAX_VERTICES }, () => [
        ...WIDEST_POSITION,
      ]),
    },
    bufferM: 100_000,
    active: true,
    alertOnEnter: true,
    properties: {
      note: 'x'.repeat(ZONE_PROPERTIES_MAX_BYTES),
      source: 'x'.repeat(500),
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return encodedSnapshotBytes(snapshot, source) + EVENT_HEADER_ALLOWANCE_BYTES;
}
