import { Readable } from 'node:stream';

import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import { toProblemResponse } from '@darmawanweb/ais-its-nest';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
  RequirePlatformAdmin,
} from '@darmawanweb/ais-its-nest/auth';
import {
  ApiPageResponse,
  bboxOf,
  UuidParam,
} from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiProduces,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Zone } from '../../domain/zone.js';
import { featureCollectionJson } from '../../domain/zone-map.js';
import { parseIfMatch, zoneEtag } from '../../domain/zone-version.js';
import { CreateZoneDto } from './dto/create-zone.dto.js';
import { ListZonesQuery, ZoneGeoJsonQuery } from './dto/list-zones.query.js';
import { UpdateZoneDto } from './dto/update-zone.dto.js';
import { ValidateZoneDto, ZoneValidationDto } from './dto/validate-zone.dto.js';
import { RepublishResultDto, ZoneDto, ZoneSummaryDto } from './dto/zone.dto.js';
import { ZoneFeatureCollectionDto } from './dto/zone-feature-collection.dto.js';
import { ZoneMapService } from './zone-map.service.js';
import { ZoneRejectionsInterceptor } from './zone-rejections.interceptor.js';
import { ZonesService } from './zones.service.js';

/** Media type of the map layer (RFC 7946 §12). */
const GEOJSON_MEDIA_TYPE = 'application/geo+json; charset=utf-8';

/** OpenAPI description of the `ETag` response header. */
const ETAG_HEADER = {
  ETag: {
    description:
      'Version of the zone (the quoted updatedAt); send it in If-Match to change or delete exactly this version',
    schema: { type: 'string', example: '"2026-11-21T10:00:00.123Z"' },
  },
};

/** OpenAPI description of the optional `If-Match` request header. */
const IF_MATCH_HEADER = {
  name: 'If-Match',
  required: false,
  description:
    'ETag of the version the change is based on (or *): answered with 412 ZONE_VERSION_CONFLICT when the zone changed since. Recommended for every editor (prevents lost updates)',
};

/** Sets the `ETag` of a zone on the response and returns the zone DTO. */
function withEtag(reply: FastifyReply, zone: Zone): ZoneDto {
  void reply.header('ETag', zoneEtag(zone));
  return new ZoneDto(zone);
}

/** The request path without its query string (`ProblemDetails.instance`). */
function pathOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url;
}

/**
 * Zones and geofences: `/api/v2/zones` (gateway route of the geo service,
 * spec §12). Reads need `zone:read`, writes `zone:write` (contracts
 * `ROLE_PERMISSIONS`); tenancy and the global-zone rules are enforced by
 * {@link ZonesService}, the map layer by {@link ZoneMapService}.
 */
@ApiTags('zones')
@Controller('zones')
export class ZonesController {
  constructor(
    private readonly zones: ZonesService,
    private readonly map: ZoneMapService,
  ) {}

  @Get()
  @RequirePermissions('zone:read')
  @ApiOperation({
    summary:
      'List zones (global + own organization; authority/super_admin: all)',
    description:
      'Page-based list without geometries (use GET /zones/:id or /zones/geojson). bbox matches zones whose area of effect (geometry and bufferM, e.g. the circle of a point zone) reaches the box in lon/lat.',
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
        global: query.global,
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
  @Header('Content-Type', GEOJSON_MEDIA_TYPE)
  @ApiProduces('application/geo+json')
  @ApiOperation({
    summary: 'Visible zones as a GeoJSON FeatureCollection for the web map',
    description:
      'Organization zones reach the map only here (the Martin tiles serve global zones). Active zones by default; geometries simplified for `zoom` and rounded to 6 decimals; at most ZONES_GEOJSON_MAX_FEATURES features and ZONES_GEOJSON_MAX_VERTICES vertices per response (`truncated`, `truncatedBy`). The response is streamed.',
  })
  @ApiOkResponse({ type: ZoneFeatureCollectionDto })
  async geojson(
    @Query() query: ZoneGeoJsonQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const events = await this.map.layer(
      {
        filter: {
          kinds: query.kind,
          active: query.active,
          bbox: bboxOf(query),
          orgId: query.orgId,
          global: query.global,
        },
        zoom: query.zoom,
      },
      principal,
    );
    return new StreamableFile(Readable.from(featureCollectionJson(events)), {
      type: GEOJSON_MEDIA_TYPE,
    });
  }

  @Post('republish')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('zone:write')
  @RequirePlatformAdmin()
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

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('zone:write')
  @ApiOperation({
    summary: 'Check a zone draft against the input rules without saving it',
    description:
      'Dry run of the input rules of POST /zones (README steps 2-8), for editors while drawing: GeoJSON structure and WGS84 bounds, geometry type per kind, at most 50 000 vertices, bufferM > 0 for point zones, no edge across the antimeridian, properties of the kind, PostGIS ST_IsValidDetail. Nothing is stored or published. A broken rule answers 200 with valid=false and problem = the problem details POST /zones would answer (e.g. ZONE_GEOMETRY_INVALID with reason and location [lon, lat] of a self-intersection). Owner, quota, code, If-Match and snapshot size are checked by the write only. A malformed body (kind or geometry missing, bufferM out of range) answers 400 VALIDATION_FAILED.',
  })
  @ApiOkResponse({ type: ZoneValidationDto })
  async validate(
    @Body() body: ValidateZoneDto,
    @Req() request: FastifyRequest,
  ): Promise<ZoneValidationDto> {
    const { geometry, problem } = await this.zones.validate(body);
    return new ZoneValidationDto(
      geometry,
      problem === null
        ? null
        : toProblemResponse(problem, {
            instance: pathOf(request),
            requestId: request.id,
            exposeInternalErrors: false,
          }).body,
    );
  }

  @Get(':id')
  @RequirePermissions('zone:read')
  @ApiOperation({ summary: 'Get a zone with its geometry' })
  @ApiOkResponse({ type: ZoneDto, headers: ETAG_HEADER })
  async get(
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ZoneDto> {
    return withEtag(reply, await this.zones.get(id, principal));
  }

  @Post()
  @RequirePermissions('zone:write')
  @UseInterceptors(ZoneRejectionsInterceptor)
  @ApiOperation({
    summary:
      'Create a zone (global: super_admin/authority; else in the active organization)',
  })
  @ApiCreatedResponse({ type: ZoneDto, headers: ETAG_HEADER })
  @ApiConflictResponse({
    description: 'ZONE_CODE_TAKEN or ZONE_QUOTA_EXCEEDED (problem details)',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'ZONE_GEOMETRY_TYPE_NOT_ALLOWED, ZONE_GEOMETRY_TOO_COMPLEX, ZONE_BUFFER_REQUIRED, ZONE_GEOMETRY_CROSSES_ANTIMERIDIAN, ZONE_GEOMETRY_INVALID or ZONE_SNAPSHOT_TOO_LARGE (problem details)',
  })
  async create(
    @Body() body: CreateZoneDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ZoneDto> {
    return withEtag(reply, await this.zones.create(body, principal, request));
  }

  @Patch(':id')
  @RequirePermissions('zone:write')
  @UseInterceptors(ZoneRejectionsInterceptor)
  @ApiOperation({
    summary: 'Change a zone (geometry re-validated)',
    description:
      'Send the ETag of the version you edited in If-Match: a zone changed since answers 412 ZONE_VERSION_CONFLICT instead of being overwritten.',
  })
  @ApiHeader(IF_MATCH_HEADER)
  @ApiOkResponse({ type: ZoneDto, headers: ETAG_HEADER })
  @ApiPreconditionFailedResponse({
    description: 'ZONE_VERSION_CONFLICT: the zone changed since it was read',
  })
  @ApiConflictResponse({ description: 'ZONE_QUOTA_EXCEEDED' })
  @ApiUnprocessableEntityResponse({
    description: 'Geometry rules (see POST), ZONE_SNAPSHOT_TOO_LARGE',
  })
  async update(
    @UuidParam() id: string,
    @Body() body: UpdateZoneDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ZoneDto> {
    const precondition = parseIfMatch(ifMatch);
    return withEtag(
      reply,
      await this.zones.update(id, body, principal, request, precondition),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('zone:write')
  @UseInterceptors(ZoneRejectionsInterceptor)
  @ApiOperation({ summary: 'Delete a zone and publish its tombstone' })
  @ApiHeader(IF_MATCH_HEADER)
  @ApiNoContentResponse()
  @ApiPreconditionFailedResponse({
    description: 'ZONE_VERSION_CONFLICT: the zone changed since it was read',
  })
  async remove(
    @UuidParam() id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.zones.remove(id, principal, request, parseIfMatch(ifMatch));
  }
}
