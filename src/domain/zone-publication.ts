import { ZONE_MAX_VERTICES } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  eventMessageSize,
  EventTooLargeError,
} from '@darmawanweb/ais-its-nest/nats';

import { ZoneSnapshotTooLargeError } from './zone-errors.js';
import { ZONE_PROPERTIES_MAX_BYTES } from './zone-properties.js';

/**
 * Publication budget of zone events. NATS refuses messages larger than the
 * server's `max_payload` (headers included; 1 MiB by default, 4 MB on the
 * platform server), and the outbox relay can only park such a row: the zone
 * would be stored and mapped but never reach the detectors. The zone writes
 * therefore pass the server's limit to the kit's `enqueueEvent({ maxBytes })`,
 * which measures the event (`eventMessageSize`: the encoded contracts
 * envelope plus a 1 KiB header allowance) and throws `EventTooLargeError`
 * before the row is inserted; {@link zonePublicationError} turns it into
 * `422 ZONE_SNAPSHOT_TOO_LARGE`, and the transaction rolls back.
 */

/** `max_payload` of a NATS server started without configuration, bytes. */
export const NATS_DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * The problem of a refused zone event: the kit's `EventTooLargeError`
 * becomes `422 ZONE_SNAPSHOT_TOO_LARGE` (`snapshotBytes` = the message size,
 * `maxBytes` = the server's `max_payload`); any other error is returned
 * unchanged.
 */
export function zonePublicationError(error: unknown): unknown {
  return error instanceof EventTooLargeError
    ? new ZoneSnapshotTooLargeError(error.sizeBytes, error.maxBytes, error)
    : error;
}

/** The widest position the registry stores: 9 decimals, negative, 3-digit longitude. */
const WIDEST_POSITION: [number, number] = [-179.123456789, -89.123456789];

/**
 * Size of the NATS message of the largest snapshot the input rules allow —
 * {@link ZONE_MAX_VERTICES} positions of maximal width (9 decimals as stored)
 * and properties of {@link ZONE_PROPERTIES_MAX_BYTES} with a 500-character
 * `source` — as the kit's `eventMessageSize` counts it (header allowance
 * included): the `max_payload` a NATS server needs so that every valid zone
 * can be published (about 1.6 MB).
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
  return eventMessageSize(EVENT_TYPES.GEO_ZONE_UPSERTED, snapshot, { source });
}
