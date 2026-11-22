import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import * as schema from './db/schema.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { GeoOutboxModule } from './modules/outbox/outbox.module.js';
import { SeedModule } from './modules/seed/seed.module.js';
import { TilesModule } from './modules/tiles/tiles.module.js';
import { ZonesModule } from './modules/zones/zones.module.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot.
    DatabaseModule.forRoot({ schema }),
    // Streams this service PRODUCES to (created / widened at boot): the zone
    // snapshots (GEO, compacted: one message per zone) and its audit records.
    NatsModule.forRoot({ streams: ['GEO', 'AUDIT'] }),
    // Global default-deny guard: every route needs a principal unless @Public().
    // No route accepts API keys, so key introspection is off.
    AuthModule.forRoot({ apiKeys: false }),
    // Builds the audit.recorded.v1 records (written through the outbox).
    AuditModule,
    GeoOutboxModule,
    ZonesModule,
    SeedModule,
    // Re-applies the tiles_ro grants of the Martin sources after migrations.
    TilesModule,
    MethodologyModule,
  ],
})
export class AppModule {}
