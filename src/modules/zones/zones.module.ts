import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module.js';
import { ZonesController } from './zones.controller.js';
import { ZonesRepository } from './zones.repository.js';
import { ZonesService } from './zones.service.js';

/** The zones/geofences registry (spec §13.6). */
@Module({
  imports: [OutboxModule],
  controllers: [ZonesController],
  providers: [ZonesService, ZonesRepository],
  exports: [ZonesService],
})
export class ZonesModule {}
