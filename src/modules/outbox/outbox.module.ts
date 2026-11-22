import { Module } from '@nestjs/common';

import { GeoOutboxRelay } from './geo-outbox.relay.js';
import { PublicationLimits } from './publication-limits.js';

/**
 * The transactional outbox relay of the service (spec §13.6) and the
 * publication limits of the NATS server. Requires `DatabaseModule` and
 * `NatsModule` (streams `GEO` and `AUDIT` produced). Rows are written by the
 * zones unit of work with the kit's `enqueueEvent`.
 */
@Module({
  providers: [GeoOutboxRelay, PublicationLimits],
  exports: [GeoOutboxRelay, PublicationLimits],
})
export class GeoOutboxModule {}
