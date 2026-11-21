import {
  provisionServiceSchema,
  startTestInfra,
} from '@darmawanweb/ais-its-nest/testing';
import type { TestProject } from 'vitest/node';

import { SERVICE } from '../../src/service.js';

/**
 * Starts TimescaleDB/PostGIS and NATS once for all integration test files,
 * provisions the service schema and role like `infra/postgres/bootstrap.sql`
 * (without `tiles_ro`: the tiles test creates it) and provides the endpoints
 * (`inject('infra')`).
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // `test.env` does not reach the main process that runs this setup.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const infra = await startTestInfra({ postgres: true, nats: true });
  try {
    const databaseUrl = await provisionServiceSchema(
      infra.postgres.adminUrl,
      SERVICE.schema,
    );
    project.provide('infra', {
      databaseUrl,
      adminUrl: infra.postgres.adminUrl,
      natsUrl: infra.nats.url,
    });
  } catch (error) {
    await infra.stop();
    throw error;
  }
  return () => infra.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    infra: {
      /** `DATABASE_URL` of the service role (schema `geo`). */
      databaseUrl: string;
      /** Superuser URL of the test database (roles, extra schemas). */
      adminUrl: string;
      natsUrl: string;
    };
  }
}
