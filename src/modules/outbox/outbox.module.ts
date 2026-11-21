import { Module } from '@nestjs/common';

import { GeoOutboxRelay } from './geo-outbox.relay.js';

/**
 * The transactional outbox relay of the service (spec §13.6). Requires
 * `DatabaseModule` and `NatsModule` (streams `GEO` and `AUDIT` produced).
 * Rows are written by the zones unit of work with the kit's `enqueueEvent`.
 */
@Module({
  providers: [GeoOutboxRelay],
  exports: [GeoOutboxRelay],
})
export class GeoOutboxModule {}
