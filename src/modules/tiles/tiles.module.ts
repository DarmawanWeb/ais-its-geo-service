import { Module } from '@nestjs/common';

import { TilesGrants } from './tiles-grants.js';

/**
 * The Martin tiles sources of the schema (`zones_tiles` view and
 * `zones_tiles_mvt` function, created by the migrations): keeps the grants
 * of the read-only role `tiles_ro` in place (spec §6).
 */
@Module({ providers: [TilesGrants] })
export class TilesModule {}
