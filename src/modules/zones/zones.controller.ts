import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiPageResponse, bboxOf } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { CreateZoneDto } from './dto/create-zone.dto.js';
import { ListZonesQuery, ZoneGeoJsonQuery } from './dto/list-zones.query.js';
import { UpdateZoneDto } from './dto/update-zone.dto.js';
import { RepublishResultDto, ZoneDto, ZoneSummaryDto } from './dto/zone.dto.js';
import { ZoneFeatureCollectionDto } from './dto/zone-feature-collection.dto.js';
import { ZonesService } from './zones.service.js';

/**
 * Zones and geofences: `/api/v2/zones` (gateway route of the geo service,
 * spec §12). Reads need `zone:read`, writes `zone:write` (contracts
 * `ROLE_PERMISSIONS`); tenancy and the global-zone rules are enforced by
 * {@link ZonesService}.
 */
@ApiTags('zones')
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  @RequirePermissions('zone:read')
  @ApiOperation({
    summary:
      'List zones (global + own organization; authority/super_admin: all)',
    description:
      'Page-based list without geometries (use GET /zones/:id or /zones/geojson). bbox matches zones whose geometry intersects the box in lon/lat.',
  })
  @ApiPageResponse(ZoneSummaryDto)
  async list(
    @Query() query: ListZonesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Paginated<ZoneSummaryDto>> {
    const page = await this.zones.list(
      {
        kinds: query.kind,
        active: query.active,
        bbox: bboxOf(query),
        orgId: query.orgId,
        search: query.search,
      },
      { page: query.page, pageSize: query.pageSize },
      principal,
    );
    return {
      data: page.data.map((zone) => new ZoneSummaryDto(zone)),
      meta: page.meta,
    };
  }

  @Get('geojson')
  @RequirePermissions('zone:read')
  @Header('Content-Type', 'application/geo+json; charset=utf-8')
  @ApiProduces('application/geo+json')
  @ApiOperation({
    summary: 'Visible zones as a GeoJSON FeatureCollection for the web map',
    description:
      'Organization zones reach the map only here (the Martin tiles serve global zones). Active zones by default; coordinates rounded to 6 decimals.',
  })
  @ApiOkResponse({ type: ZoneFeatureCollectionDto })
  async geojson(
    @Query() query: ZoneGeoJsonQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ZoneFeatureCollectionDto> {
    const set = await this.zones.features(
      {
        kinds: query.kind,
        active: query.active,
        bbox: bboxOf(query),
        orgId: query.orgId,
      },
      principal,
    );
    return new ZoneFeatureCollectionDto(set);
  }

  @Post('republish')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('zone:write')
  @ApiOperation({
    summary:
      'Republish the snapshot of every zone to the GEO stream (super_admin)',
    description:
      'Enqueues one geo.zone.upserted.v1 per zone in the outbox; the relay publishes them asynchronously.',
  })
  @ApiAcceptedResponse({ type: RepublishResultDto })
  async republish(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RepublishResultDto> {
    return new RepublishResultDto(
      await this.zones.republish(principal, request),
    );
  }

  @Get(':id')
  @RequirePermissions('zone:read')
  @ApiOperation({ summary: 'Get a zone with its geometry' })
  @ApiOkResponse({ type: ZoneDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ZoneDto> {
    return new ZoneDto(await this.zones.get(id, principal));
  }

  @Post()
  @RequirePermissions('zone:write')
  @ApiOperation({
    summary:
      'Create a zone (global: super_admin/authority; else in the active organization)',
  })
  @ApiCreatedResponse({ type: ZoneDto })
  async create(
    @Body() body: CreateZoneDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ZoneDto> {
    return new ZoneDto(await this.zones.create(body, principal, request));
  }

  @Patch(':id')
  @RequirePermissions('zone:write')
  @ApiOperation({ summary: 'Change a zone (geometry re-validated)' })
  @ApiOkResponse({ type: ZoneDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateZoneDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ZoneDto> {
    return new ZoneDto(await this.zones.update(id, body, principal, request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('zone:write')
  @ApiOperation({ summary: 'Delete a zone and publish its tombstone' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.zones.remove(id, principal, request);
  }
}
