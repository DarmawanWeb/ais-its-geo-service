import { ConfigValidationError, loadConfig } from '@darmawanweb/ais-its-nest';
import { describe, expect, it } from 'vitest';

import { configSchema } from './config.js';
import { SERVICE } from './service.js';

/** Loads the configuration from `env` only (no .env file, no process.env). */
function load(env: Record<string, string> = {}) {
  return loadConfig(configSchema, {
    env: { LOG_LEVEL: 'silent', ...env },
    envFile: false,
    output: null,
  });
}

describe('configSchema', () => {
  it('applies the service defaults (spec §3, §4, §6)', () => {
    const config = load();

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      SERVICE_NAME: SERVICE.name,
      SERVICE_VERSION: SERVICE.version,
      PORT: SERVICE.port,
      DATABASE_SCHEMA: SERVICE.schema,
      DATABASE_URL: `postgres://${SERVICE.schema}_svc:${SERVICE.schema}_svc@localhost:5432/aisits`,
      NATS_URL: ['nats://localhost:4222'],
    });
  });

  it('applies the geo defaults (body limit, map cap, outbox relay)', () => {
    expect(load()).toMatchObject({
      HTTP_BODY_LIMIT_BYTES: 4 * 1024 * 1024,
      ZONES_GEOJSON_MAX_FEATURES: 5_000,
      OUTBOX_RELAY_ENABLED: true,
      OUTBOX_POLL_INTERVAL_MS: 500,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_RETRY_BASE_MS: 1_000,
      OUTBOX_RETRY_MAX_MS: 60_000,
      OUTBOX_RETENTION_HOURS: 24,
    });
    expect(
      load({ OUTBOX_RELAY_ENABLED: 'false', OUTBOX_BATCH_SIZE: '10' }),
    ).toMatchObject({ OUTBOX_RELAY_ENABLED: false, OUTBOX_BATCH_SIZE: 10 });
    expect(() => load({ OUTBOX_BATCH_SIZE: '0' })).toThrow(
      ConfigValidationError,
    );
  });

  it('reads overrides from the environment', () => {
    expect(
      load({ PORT: '4000', NATS_URL: 'nats://a:4222,nats://b:4222' }),
    ).toMatchObject({
      PORT: 4000,
      NATS_URL: ['nats://a:4222', 'nats://b:4222'],
    });
  });

  it('refuses invalid values', () => {
    expect(() => load({ PORT: 'eighty' })).toThrow(ConfigValidationError);
  });

  it('refuses the development secrets in production', () => {
    expect(() =>
      load({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@db:5432/aisits',
      }),
    ).toThrow(ConfigValidationError);
  });
});
