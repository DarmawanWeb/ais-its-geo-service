import { Module } from '@nestjs/common';

import { GeoOutboxModule } from '../outbox/outbox.module.js';
import { ZoneMapService } from './zone-map.service.js';
import { ZoneRejectionsInterceptor } from './zone-rejections.interceptor.js';
import { ZonesController } from './zones.controller.js';
import { ZonesRepository } from './zones.repository.js';
import { ZonesService } from './zones.service.js';

/** The zones/geofences registry (spec §13.6) and its map layer. */
@Module({
  imports: [GeoOutboxModule],
  controllers: [ZonesController],
  providers: [
    ZonesService,
    ZoneMapService,
    ZonesRepository,
    ZoneRejectionsInterceptor,
  ],
  exports: [ZonesService],
})
export class ZonesModule {}
