import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { describe, expect, it } from 'vitest';

import {
  parseZoneProperties,
  ZONE_PROPERTIES_MAX_BYTES,
} from './zone-properties.js';

/** The field errors of rejected properties. */
function fieldsOf(attempt: () => unknown): string[] {
  try {
    attempt();
  } catch (error) {
    if (error instanceof ValidationFailedError) {
      return (error.errors ?? []).map((item) => item.field);
    }
    throw error;
  }
  throw new Error('properties were accepted');
}

describe('parseZoneProperties', () => {
  it('accepts the known keys of the kind and keeps unknown ones', () => {
    expect(
      parseZoneProperties('pipeline', {
        operator: 'PHE WMO',
        markers: [{ name: 'KP 29.200', lat: -6.87, lon: 112.72 }],
        surveyYear: 2019,
      }),
    ).toEqual({
      operator: 'PHE WMO',
      markers: [{ name: 'KP 29.200', lat: -6.87, lon: 112.72 }],
      surveyYear: 2019,
    });
    expect(parseZoneProperties('shallow_water', { depthM: 4.5 })).toEqual({
      depthM: 4.5,
    });
  });

  it('refuses invalid known keys instead of dropping them', () => {
    expect(
      fieldsOf(() =>
        parseZoneProperties('pipeline', {
          markers: [{ name: 'KP 1', lat: 95, lon: 112 }],
        }),
      ),
    ).toEqual(['properties.markers.0.lat']);
    expect(
      fieldsOf(() => parseZoneProperties('port', { unlocode: 'batam' })),
    ).toEqual(['properties.unlocode']);
    expect(
      fieldsOf(() => parseZoneProperties('shallow_water', { depthM: -1 })),
    ).toEqual(['properties.depthM']);
  });

  it('reserves "source" for the top-level field', () => {
    expect(
      fieldsOf(() =>
        parseZoneProperties('restricted', { source: 'Notice to mariners' }),
      ),
    ).toEqual(['properties.source']);
  });

  it(`limits the JSON size to ${ZONE_PROPERTIES_MAX_BYTES} bytes`, () => {
    const big = { note: 'x'.repeat(ZONE_PROPERTIES_MAX_BYTES) };
    expect(fieldsOf(() => parseZoneProperties('custom', big))).toEqual([
      'properties',
    ]);
  });
});
