import {
  ZoneDeletedV1Schema,
  ZoneSnapshotV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import type { Zone } from './zone.js';
import {
  toZoneFeature,
  toZoneSnapshot,
  toZoneTombstone,
} from './zone-snapshot.js';

const ZONE: Zone = {
  id: '019a0000-0000-7000-8000-000000000001',
  orgId: null,
  code: 'mvp-pipeline',
  name: 'Subsea pipeline (MVP dataset)',
  kind: 'pipeline',
  geometry: {
    type: 'LineString',
    coordinates: [
      [112.719384869, -6.871972196],
      [112.719433852, -6.862938863],
    ],
  },
  bufferM: 1750,
  alertOnEnter: false,
  active: true,
  properties: {
    note: 'MVP dataset, origin to be cited from the thesis',
    markers: [{ name: 'KP 29.200', lat: -6.871972196, lon: 112.719384869 }],
  },
  source: 'legacy MVP backend data/legacy/pipeline.json',
  createdBy: null,
  createdAt: new Date('2026-11-20T10:00:00.000Z'),
  updatedAt: new Date('2026-11-21T08:30:00.123Z'),
};

describe('toZoneSnapshot', () => {
  it('maps a zone to a valid ZoneSnapshotV1', () => {
    const snapshot = toZoneSnapshot(ZONE);

    expect(snapshot).toEqual({
      id: ZONE.id,
      orgId: null,
      code: 'mvp-pipeline',
      name: 'Subsea pipeline (MVP dataset)',
      kind: 'pipeline',
      geometry: ZONE.geometry,
      bufferM: 1750,
      active: true,
      alertOnEnter: false,
      properties: {
        note: 'MVP dataset, origin to be cited from the thesis',
        markers: [{ name: 'KP 29.200', lat: -6.871972196, lon: 112.719384869 }],
        source: 'legacy MVP backend data/legacy/pipeline.json',
      },
      updatedAt: '2026-11-21T08:30:00.123Z',
    });
    expect(ZoneSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
  });

  it('leaves properties.source out when the provenance is unknown', () => {
    const snapshot = toZoneSnapshot({
      ...ZONE,
      orgId: '019a0000-0000-7000-8000-0000000000aa',
      source: null,
    });
    expect(snapshot.properties).not.toHaveProperty('source');
    expect(snapshot.orgId).toBe('019a0000-0000-7000-8000-0000000000aa');
  });

  it('never shares the zone properties object', () => {
    const snapshot = toZoneSnapshot(ZONE);
    expect(snapshot.properties).not.toBe(ZONE.properties);
  });
});

describe('toZoneTombstone', () => {
  it('maps a zone to a valid ZoneDeletedV1', () => {
    const tombstone = toZoneTombstone(ZONE);
    expect(tombstone).toEqual({ id: ZONE.id, orgId: null });
    expect(ZoneDeletedV1Schema.parse(tombstone)).toEqual(tombstone);
  });
});

describe('toZoneFeature', () => {
  it('maps a zone to a GeoJSON Feature with the zone id', () => {
    expect(toZoneFeature(ZONE)).toEqual({
      type: 'Feature',
      id: ZONE.id,
      geometry: ZONE.geometry,
      properties: {
        id: ZONE.id,
        orgId: null,
        global: true,
        code: 'mvp-pipeline',
        name: 'Subsea pipeline (MVP dataset)',
        kind: 'pipeline',
        bufferM: 1750,
        alertOnEnter: false,
        active: true,
        updatedAt: '2026-11-21T08:30:00.123Z',
        zoneProperties: {
          ...ZONE.properties,
          source: 'legacy MVP backend data/legacy/pipeline.json',
        },
      },
    });
  });
});
