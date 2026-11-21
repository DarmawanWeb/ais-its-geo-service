import { InvalidEventError } from '@darmawanweb/ais-its-contracts/events';
import { EventSubjectMismatchError } from '@darmawanweb/ais-its-nest/nats';

/** Retry delays of the outbox relay. */
export interface RetryDelayOptions {
  /** Delay after the first failure, ms. */
  readonly baseMs: number;
  /** Largest delay, ms. */
  readonly maxMs: number;
}

/**
 * Delay before the next publication attempt of an outbox row that failed
 * `attempts` times: exponential `baseMs × 2^(attempts − 1)` capped at
 * `maxMs`, with "equal jitter" (a random value in the upper half) so that
 * the rows of an outage do not all retry at the same instant.
 *
 * @param random - uniform random number in [0, 1) (injectable for tests).
 */
export function outboxRetryDelayMs(
  attempts: number,
  options: RetryDelayOptions,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

/**
 * `true` for publication errors that no retry can fix, so the row is marked
 * `failed_at` instead of blocking its zone forever:
 * - the payload no longer matches the contracts schema (`InvalidEventError`);
 * - the subject is inconsistent (`EventSubjectMismatchError`);
 * - the message exceeds the server's `max_payload` (NATS `InvalidArgumentError`
 *   "max_payload size exceeded"; the platform's NATS allows 4 MB, a 50 000
 *   vertex zone needs about 1.5 MB).
 */
export function isPermanentPublishError(error: unknown): boolean {
  if (
    error instanceof InvalidEventError ||
    error instanceof EventSubjectMismatchError
  ) {
    return true;
  }
  return error instanceof Error && /max_payload/i.test(error.message);
}

/** Message of an unknown error, bounded for the `last_error` column. */
export function errorText(error: unknown, maxLength = 1_000): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, maxLength);
}
