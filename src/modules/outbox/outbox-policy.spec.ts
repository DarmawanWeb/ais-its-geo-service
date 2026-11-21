import { InvalidEventError } from '@darmawanweb/ais-its-contracts/events';
import { EventSubjectMismatchError } from '@darmawanweb/ais-its-nest/nats';
import { describe, expect, it } from 'vitest';

import {
  errorText,
  isPermanentPublishError,
  outboxRetryDelayMs,
} from './outbox-policy.js';

const OPTIONS = { baseMs: 1_000, maxMs: 60_000 };

describe('outboxRetryDelayMs', () => {
  it('doubles per attempt between half and the full delay (equal jitter)', () => {
    expect(outboxRetryDelayMs(1, OPTIONS, () => 0)).toBe(500);
    expect(outboxRetryDelayMs(1, OPTIONS, () => 0.999_999)).toBe(1_000);
    expect(outboxRetryDelayMs(2, OPTIONS, () => 0)).toBe(1_000);
    expect(outboxRetryDelayMs(3, OPTIONS, () => 0.5)).toBe(3_000);
  });

  it('caps the delay at maxMs, also for huge attempt counts', () => {
    expect(outboxRetryDelayMs(10, OPTIONS, () => 1)).toBe(60_000);
    expect(outboxRetryDelayMs(10_000, OPTIONS, () => 0)).toBe(30_000);
  });

  it('treats attempt 0 like the first', () => {
    expect(outboxRetryDelayMs(0, OPTIONS, () => 0)).toBe(500);
  });
});

describe('isPermanentPublishError', () => {
  it('recognises invalid payloads and subjects', () => {
    expect(
      isPermanentPublishError(
        new InvalidEventError({
          success: false,
          reason: 'invalid_payload',
          message: 'Invalid geo.zone.upserted.v1 event',
          issues: [],
          type: 'geo.zone.upserted.v1',
        }),
      ),
    ).toBe(true);
    expect(
      isPermanentPublishError(
        new EventSubjectMismatchError('geo.zone.v1.a is not geo.zone.v1.b'),
      ),
    ).toBe(true);
  });

  it('recognises messages over the server max_payload', () => {
    expect(
      isPermanentPublishError(
        new Error("'payload' max_payload size exceeded"),
      ),
    ).toBe(true);
  });

  it('retries everything else (broker down, timeouts)', () => {
    expect(isPermanentPublishError(new Error('TIMEOUT'))).toBe(false);
    expect(isPermanentPublishError('closed')).toBe(false);
  });
});

describe('errorText', () => {
  it('bounds the stored message', () => {
    expect(errorText(new Error('x'.repeat(2_000)))).toHaveLength(1_000);
    expect(errorText(42)).toBe('42');
  });
});
