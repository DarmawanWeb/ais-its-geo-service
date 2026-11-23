import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import type { ZoneSummary } from '../../../domain/zone.js';
import type { ZoneGeometry } from '../../../domain/zone-geometry.js';
import { CreateZoneDto } from './create-zone.dto.js';
import { ListZonesQuery, ZoneGeoJsonQuery } from './list-zones.query.js';
import { UpdateZoneDto } from './update-zone.dto.js';
import { ValidateZoneDto, ZoneValidationDto } from './validate-zone.dto.js';
import { ZoneDto, ZoneSummaryDto } from './zone.dto.js';

/** Validates like the kit's ValidationPipe (transform, whitelist, forbidNonWhitelisted). */
async function errorsOf(
  type: new () => object,
  input: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(type, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}).sort(),
    ]),
  );
}

const VALID = {
  code: 'idbtm-anchorage-a',
  name: '  Batam anchorage A  ',
  kind: 'anchorage',
  geometry: { type: 'Point', coordinates: [104.0, 1.1] },
  bufferM: 500,
};

describe('CreateZoneDto', () => {
  it('accepts a complete zone and trims the name', async () => {
    const dto = plainToInstance(CreateZoneDto, VALID);
    expect(dto.name).toBe('Batam anchorage A');
    expect(await validate(dto)).toEqual([]);
  });

  it('refuses bad codes, kinds, buffers and a non-object geometry', async () => {
    expect(
      await errorsOf(CreateZoneDto, {
        ...VALID,
        code: 'Not A Slug',
        kind: 'lake',
        bufferM: -1,
        geometry: 'POINT(104 1)',
      }),
    ).toEqual({
      code: ['matches'],
      kind: ['isIn'],
      bufferM: ['min'],
      geometry: ['isObject'],
    });
    expect(
      await errorsOf(CreateZoneDto, { ...VALID, bufferM: 100_001 }),
    ).toEqual({ bufferM: ['max'] });
  });

  it('refuses null for fields without a null value, accepts a null source', async () => {
    expect(
      await errorsOf(CreateZoneDto, {
        ...VALID,
        bufferM: null,
        alertOnEnter: null,
        active: null,
        properties: null,
        global: null,
      }),
    ).toEqual({
      bufferM: ['isNumber', 'max', 'min'],
      alertOnEnter: ['isBoolean'],
      active: ['isBoolean'],
      properties: ['isObject'],
      global: ['isBoolean'],
    });
    expect(await errorsOf(CreateZoneDto, { ...VALID, source: null })).toEqual(
      {},
    );
  });

  it('never accepts an organization id from the client', async () => {
    expect(
      await errorsOf(CreateZoneDto, {
        ...VALID,
        orgId: '01900000-0000-7000-8000-00000000000a',
      }),
    ).toEqual({ orgId: ['whitelistValidation'] });
  });
});

describe('UpdateZoneDto', () => {
  it('makes every field optional, allows clearing the source, keeps the code', async () => {
    expect(await errorsOf(UpdateZoneDto, {})).toEqual({});
    expect(await errorsOf(UpdateZoneDto, { source: null })).toEqual({});
    expect(await errorsOf(UpdateZoneDto, { code: 'other' })).toEqual({
      code: ['whitelistValidation'],
    });
    expect(await errorsOf(UpdateZoneDto, { global: true })).toEqual({
      global: ['whitelistValidation'],
    });
  });

  it('refuses null for every field except the source (NOT NULL columns)', async () => {
    expect(
      await errorsOf(UpdateZoneDto, {
        name: null,
        kind: null,
        geometry: null,
        bufferM: null,
        alertOnEnter: null,
        active: null,
        properties: null,
      }),
    ).toEqual({
      name: ['isLength', 'isString'],
      kind: ['isIn'],
      geometry: ['isObject'],
      bufferM: ['isNumber', 'max', 'min'],
      alertOnEnter: ['isBoolean'],
      active: ['isBoolean'],
      properties: ['isObject'],
    });
  });

  it('validates the fields it receives like the create DTO', async () => {
    expect(
      await errorsOf(UpdateZoneDto, { name: '', bufferM: -5, kind: 'lake' }),
    ).toEqual({ name: ['isLength'], bufferM: ['min'], kind: ['isIn'] });
  });
});

describe('ListZonesQuery', () => {
  it('parses repeated and comma separated kinds, booleans and pages', () => {
    const query = plainToInstance(ListZonesQuery, {
      kind: ['pipeline,restricted', 'mpa'],
      active: 'false',
      page: '2',
      pageSize: '5',
    });
    expect(query).toMatchObject({
      kind: ['pipeline', 'restricted', 'mpa'],
      active: false,
      page: 2,
      pageSize: 5,
    });
  });

  it('refuses unknown kinds, a malformed bbox and non-boolean flags', async () => {
    expect(
      await errorsOf(ListZonesQuery, {
        kind: 'pipeline,lake',
        bbox: '104,1,105',
        active: 'yes',
      }),
    ).toEqual({ kind: ['isIn'], bbox: ['isBBox'], active: ['isBoolean'] });
  });
});

describe('ListZonesQuery global filter', () => {
  const ORG = '01900000-0000-7000-8000-00000000000a';

  it('parses global=true|false (and 1|0), absent = both', async () => {
    expect(plainToInstance(ListZonesQuery, { global: 'true' }).global).toBe(
      true,
    );
    expect(plainToInstance(ListZonesQuery, { global: '0' }).global).toBe(false);
    expect(plainToInstance(ListZonesQuery, {}).global).toBeUndefined();
    expect(
      await errorsOf(ListZonesQuery, { global: 'false', orgId: ORG }),
    ).toEqual({});
  });

  it('refuses a non-boolean and global=true with an orgId', async () => {
    expect(await errorsOf(ListZonesQuery, { global: 'yes' })).toEqual({
      global: ['isBoolean'],
    });
    expect(
      await errorsOf(ListZonesQuery, { global: 'true', orgId: ORG }),
    ).toEqual({ global: ['globalWithOrgId'] });
    expect(
      await errorsOf(ZoneGeoJsonQuery, { global: 'true', orgId: ORG }),
    ).toEqual({ global: ['globalWithOrgId'] });
  });
});

describe('ZoneGeoJsonQuery', () => {
  it('defaults to active zones', () => {
    expect(plainToInstance(ZoneGeoJsonQuery, {}).active).toBe(true);
    expect(plainToInstance(ZoneGeoJsonQuery, { active: 'false' }).active).toBe(
      false,
    );
  });
});

describe('ValidateZoneDto', () => {
  it('needs a kind and a geometry object; bufferM and properties are optional', async () => {
    expect(
      await errorsOf(ValidateZoneDto, {
        kind: 'anchorage',
        geometry: { type: 'Point', coordinates: [104, 1] },
      }),
    ).toEqual({});
    expect(await errorsOf(ValidateZoneDto, {})).toEqual({
      kind: ['isIn'],
      geometry: ['isObject'],
    });
  });

  it('validates bufferM and properties like the create DTO and refuses other fields', async () => {
    expect(
      await errorsOf(ValidateZoneDto, {
        kind: 'anchorage',
        geometry: { type: 'Point', coordinates: [104, 1] },
        bufferM: null,
        properties: null,
        code: 'not-checked-here',
      }),
    ).toEqual({
      bufferM: ['isNumber', 'max', 'min'],
      properties: ['isObject'],
      code: ['whitelistValidation'],
    });
  });
});

describe('ZoneValidationDto', () => {
  it('describes the parsed geometry and the problem', () => {
    const square: ZoneGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [104, 1],
          [104.1, 1],
          [104.1, 1.1],
          [104, 1.1],
          [104, 1],
        ],
      ],
    };
    expect(new ZoneValidationDto(square, null)).toEqual({
      valid: true,
      problem: null,
      geometryType: 'Polygon',
      vertexCount: 5,
      bbox: [104, 1, 104.1, 1.1],
    });
    const problem = {
      type: 'urn:ais-its:problem:validation-failed',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
    };
    expect(new ZoneValidationDto(null, problem)).toEqual({
      valid: false,
      problem,
      geometryType: null,
      vertexCount: null,
      bbox: null,
    });
  });
});

describe('ZoneSummaryDto', () => {
  it('carries the version the ETag header and If-Match use', () => {
    const updatedAt = new Date('2026-11-21T10:00:00.123Z');
    const summary: ZoneSummary = {
      id: '01900000-0000-7000-8000-0000000000c1',
      orgId: null,
      code: 'z',
      name: 'Zone',
      kind: 'restricted',
      bufferM: 0,
      alertOnEnter: false,
      active: true,
      properties: {},
      source: null,
      createdBy: null,
      createdAt: updatedAt,
      updatedAt,
      geometryType: 'Point',
      vertexCount: 1,
      bbox: [104, 1, 104, 1],
    };
    expect(new ZoneSummaryDto(summary).etag).toBe('"2026-11-21T10:00:00.123Z"');
    const {
      geometryType: _type,
      vertexCount: _count,
      bbox: _bbox,
      ...zone
    } = summary;
    expect(
      new ZoneDto({
        ...zone,
        geometry: { type: 'Point', coordinates: [104, 1] },
      }).etag,
    ).toBe('"2026-11-21T10:00:00.123Z"');
  });
});
