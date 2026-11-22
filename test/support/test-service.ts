import { randomUUID } from 'node:crypto';

import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { PG_POOL, type Pool } from '@darmawanweb/ais-its-nest/db';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type ProviderOverride,
  type TestJwtIssuer,
  type TestTokenClaims,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';

/** A signed-in test user: roles and active organization. */
export interface TestUser {
  readonly roles: readonly Role[];
  readonly orgId: string | null;
  readonly userId?: string;
}

/** The real application on the shared containers, with a test token issuer. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  /** The service's pool (schema `geo`). */
  readonly pool: Pool;
  /** `Authorization` header with a freshly signed access token. */
  authorization(claims?: TestTokenClaims): Promise<{ authorization: string }>;
  /** Sends a JSON request as `user` (anonymous when omitted). */
  request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options?: {
      user?: TestUser;
      body?: object;
      headers?: Record<string, string>;
    },
  ): Promise<TestResponse>;
  /** Empties the zones and the outbox (test files share the schema). */
  reset(): Promise<void>;
}

/** The parts of an injected response the tests read. */
export interface TestResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- light-my-request's typed view of the JSON body
  json<T = Record<string, unknown>>(): T;
}

/** Test users of two organizations and the platform. */
export const ORG_A = randomUUID();
export const ORG_B = randomUUID();
export const USERS = {
  superAdmin: { roles: ['super_admin'], orgId: null },
  authority: { roles: ['authority'], orgId: randomUUID() },
  orgAdminA: { roles: ['org_admin'], orgId: ORG_A },
  orgAdminB: { roles: ['org_admin'], orgId: ORG_B },
  fleetManagerA: { roles: ['fleet_manager'], orgId: ORG_A },
  viewerA: { roles: ['viewer'], orgId: ORG_A },
  viewerB: { roles: ['viewer'], orgId: ORG_B },
} as const satisfies Record<string, TestUser>;

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams ensure, the outbox relay starts) without
 * listening; use `request()` / `app.inject()` and close it with `app.close()`.
 */
export async function startTestService(
  env: Readonly<Record<string, string>> = {},
  overrides: readonly ProviderOverride[] = [],
): Promise<TestService> {
  const infra = inject('infra');
  const jwt = await createTestJwtIssuer();
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: infra.natsUrl,
    OUTBOX_POLL_INTERVAL_MS: '100',
    ...env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    adapter: { bodyLimitBytes: config.HTTP_BODY_LIMIT_BYTES },
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
      ...overrides,
    ],
  });
  const pool = app.get<unknown, Pool>(PG_POOL);
  const authorization = async (claims?: TestTokenClaims) => ({
    authorization: `Bearer ${await jwt.sign(claims)}`,
  });
  return {
    app,
    config,
    jwt,
    pool,
    authorization,
    async request(method, url, options = {}) {
      const headers =
        options.user === undefined
          ? {}
          : await authorization({
              roles: options.user.roles,
              orgId: options.user.orgId,
              ...(options.user.userId === undefined
                ? {}
                : { userId: options.user.userId }),
            });
      return app.inject({
        method,
        url,
        headers: { ...headers, ...options.headers },
        ...(options.body === undefined ? {} : { payload: options.body }),
      });
    },
    async reset() {
      await pool.query('TRUNCATE zones, outbox');
    },
  };
}
