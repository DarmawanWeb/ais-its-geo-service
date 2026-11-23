import { describe, expect, it } from 'vitest';

import type { Config } from '../../config.js';
import { outboxModuleOptions } from './outbox.module.js';

describe('outboxModuleOptions', () => {
  it('runs the kit relay in per-key mode from the OUTBOX_* variables', () => {
    const config = {
      OUTBOX_RELAY_ENABLED: false,
      OUTBOX_POLL_INTERVAL_MS: 250,
      OUTBOX_BATCH_SIZE: 50,
      OUTBOX_RETRY_BASE_MS: 2_000,
      OUTBOX_RETRY_MAX_MS: 120_000,
      OUTBOX_RETENTION_HOURS: 48,
    } as Config;
    expect(outboxModuleOptions(config)).toEqual({
      mode: 'per-key',
      autoStart: false,
      pollIntervalMs: 250,
      batchSize: 50,
      retentionMs: 48 * 3_600_000,
      retry: { baseMs: 2_000, maxMs: 120_000 },
    });
  });
});
