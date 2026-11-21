import {
  type AnyEventEnvelope,
  type EventType,
  parseEnvelope,
  type StreamName,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient, OrderedConsumers } from '@darmawanweb/ais-its-nest/nats';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** A message stored in a JetStream stream, decoded. */
export interface StoredEvent {
  readonly seq: number;
  readonly subject: string;
  /** `Nats-Msg-Id` header (JetStream deduplication id). */
  readonly msgId: string | undefined;
  readonly envelope: AnyEventEnvelope;
}

/** The last message of `subject` in `stream`, or `null` when there is none. */
export async function lastMessage(
  app: NestFastifyApplication,
  stream: StreamName,
  subject: string,
): Promise<StoredEvent | null> {
  const { manager } = app.get(NatsClient);
  try {
    const stored = await manager.streams.getMessage(stream, {
      last_by_subj: subject,
    });
    if (stored === null) return null;
    const parsed = parseEnvelope(stored.data);
    if (!parsed.success) throw new Error(parsed.message);
    return {
      seq: stored.seq,
      subject: stored.subject,
      msgId: stored.header.get('Nats-Msg-Id') || undefined,
      envelope: parsed.envelope,
    };
  } catch (error) {
    if (error instanceof Error && /no message found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/** The last GEO message of a zone. */
export function lastZoneMessage(
  app: NestFastifyApplication,
  zoneId: string,
): Promise<StoredEvent | null> {
  return lastMessage(app, 'GEO', subjects.geoZone(zoneId));
}

/** Number of messages a stream keeps on `subject` (1 at most on GEO). */
export async function subjectCount(
  app: NestFastifyApplication,
  stream: StreamName,
  subject: string,
): Promise<number> {
  const { manager } = app.get(NatsClient);
  const info = await manager.streams.info(stream, {
    subjects_filter: subject,
  });
  return info.state.subjects?.[subject] ?? 0;
}

/**
 * Collects the events of an ordered (ephemeral) consumer on the GEO stream,
 * as the safety and surveillance zone projections receive them.
 */
export async function collectGeoEvents(
  app: NestFastifyApplication,
  filterSubject: string,
  eventTypes: readonly EventType[],
): Promise<{ events: AnyEventEnvelope[]; stop: () => Promise<void> }> {
  const events: AnyEventEnvelope[] = [];
  const subscription = await app.get(OrderedConsumers).start({
    name: 'geo-test-collector',
    stream: 'GEO',
    filterSubjects: [filterSubject],
    eventTypes,
    deliver: 'all',
    handler: (event) => {
      events.push(event);
    },
  });
  await subscription.caughtUp(10_000);
  return { events, stop: () => subscription.stop() };
}
