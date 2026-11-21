import { Module } from '@nestjs/common';

import { ZonesModule } from '../zones/zones.module.js';
import { ZoneSeeder } from './zone-seeder.js';

/** The seed of the MVP zones (`pnpm seed`, `ZoneSeeder`). */
@Module({
  imports: [ZonesModule],
  providers: [ZoneSeeder],
  exports: [ZoneSeeder],
})
export class SeedModule {}
