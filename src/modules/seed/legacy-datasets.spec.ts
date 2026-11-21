import { readFileSync } from 'node:fs';

import {
  countGeometryPositions,
  geometryBBox,
} from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

import { assertZoneGeometryRules } from '../../domain/zone-geometry.js';
import { parseZoneProperties } from '../../domain/zone-properties.js';
import {
  BATAM_ZONE_CODE,
  batamSeedZone,
  MVP_DATASET_NOTE,
  PIPELINE_CORRIDOR_BUFFER_M,
  PIPELINE_ZONE_CODE,
  pipelineSeedZone,
} from './legacy-datasets.js';

/** A dataset file of the repository, parsed. */
function load(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
  );
}

const PIPELINE = { path: 'data/legacy/pipeline.json', sha256: 'p' };
const BATAM = { path: 'data/legacy/batam.json', sha256: 'b' };

describe('pipelineSeedZone (data.pipeline_route)', () => {
  const { zone, repairInvalidGeometry } = pipelineSeedZone(
    load(PIPELINE.path),
    PIPELINE,
  );

  it('is the global pipeline zone with the 1 750 m corridor', () => {
    expect(zone).toMatchObject({
      code: PIPELINE_ZONE_CODE,
      kind: 'pipeline',
      bufferM: 1750,
      active: true,
      alertOnEnter: false,
    });
    expect(PIPELINE_CORRIDOR_BUFFER_M).toBe(1750);
    expect(zone.properties).toMatchObject({
      note: MVP_DATASET_NOTE,
      methodId: 'data.pipeline_route',
      dataset: PIPELINE,
    });
    expect(repairInvalidGeometry).toBe(false);
  });

  // Golden values from the legacy file (61 points, file order = the line of
  // legacy checkShipStatus, not KP order).
  it('keeps the 61 KP points in legacy file order', () => {
    expect(zone.geometry.type).toBe('LineString');
    expect(countGeometryPositions(zone.geometry)).toBe(61);
    const coordinates =
      zone.geometry.type === 'LineString' ? zone.geometry.coordinates : [];
    expect(coordinates[0]).toEqual([112.719384869178, -6.87197219605424]);
    expect(coordinates[3]).toEqual([112.719447222222, -6.85389660250285]);
    expect(coordinates[4]).toEqual([112.719227390428, -6.88101386272091]);
    expect(coordinates.at(-1)).toEqual([112.656890832097, -7.1438932181303]);
    expect(geometryBBox(zone.geometry)).toEqual([
      112.651261111111, -7.1438932181303, 112.719447222222, -6.85389660250285,
    ]);
  });

  it('keeps every KP name as a marker, duplicates included', () => {
    const markers = zone.properties.markers as { name: string }[];
    expect(markers).toHaveLength(61);
    expect(markers.slice(0, 5).map((marker) => marker.name)).toEqual([
      'KP 29.200',
      'KP 28.200',
      'KP 27.200',
      'KP 26.700',
      'KP 30.200',
    ]);
    expect(markers.filter((marker) => marker.name === 'KP 42.200')).toHaveLength(
      2,
    );
    expect(markers[0]).toEqual({
      name: 'KP 29.200',
      lat: -6.87197219605424,
      lon: 112.719384869178,
    });
  });

  it('passes the registry input rules', () => {
    expect(() => {
      assertZoneGeometryRules(zone.kind, zone.geometry, zone.bufferM);
    }).not.toThrow();
    expect(parseZoneProperties(zone.kind, zone.properties)).toEqual(
      zone.properties,
    );
  });

  it('refuses a file that is not the legacy shape', () => {
    expect(() => pipelineSeedZone({ pipeline: [] }, PIPELINE)).toThrow();
  });
});

describe('batamSeedZone (data.batam_area)', () => {
  const { zone, repairInvalidGeometry } = batamSeedZone(load(BATAM.path), BATAM);

  it('is the global transhipment area of the legacy MultiPolygon', () => {
    expect(zone).toMatchObject({
      code: BATAM_ZONE_CODE,
      kind: 'transhipment_area',
      bufferM: 0,
      active: true,
      alertOnEnter: false,
    });
    expect(zone.properties).toMatchObject({
      methodId: 'data.batam_area',
      province: 'Kepulauan Riau',
      provinceCode: '21',
      dataset: BATAM,
    });
    expect(zone.properties.note).toContain(MVP_DATASET_NOTE);
    // Known invalid (overlapping parts): repaired explicitly by the seeder.
    expect(repairInvalidGeometry).toBe(true);
  });

  // Golden values from the legacy file (methods.json: 73 parts, 795 vertices).
  it('keeps the 73 parts and 795 vertices of the legacy file', () => {
    expect(zone.geometry.type).toBe('MultiPolygon');
    expect(
      zone.geometry.type === 'MultiPolygon' ? zone.geometry.coordinates : [],
    ).toHaveLength(73);
    expect(countGeometryPositions(zone.geometry)).toBe(795);
    const [minLon, minLat, maxLon, maxLat] = geometryBBox(zone.geometry);
    expect(minLon).toBeCloseTo(103.311, 3);
    expect(minLat).toBeCloseTo(-0.684, 3);
    expect(maxLon).toBeCloseTo(109.118, 3);
    expect(maxLat).toBeCloseTo(4.735, 3);
  });

  it('passes the kind rules (validity is checked with PostGIS)', () => {
    expect(() => {
      assertZoneGeometryRules(zone.kind, zone.geometry, zone.bufferM);
    }).not.toThrow();
  });
});
