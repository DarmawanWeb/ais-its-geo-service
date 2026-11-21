import { randomBytes } from 'node:crypto';

import type { TestResponse } from './test-service.js';

/** A unique zone code (test files share the schema and the GEO stream). */
export function zoneCode(prefix = 'zone'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** `value` rounded to 9 decimals, the precision the API returns. */
function round9(value: number): number {
  return Number(value.toFixed(9));
}

/** An axis-aligned square polygon `[lon, lat]` with sides of `size` degrees. */
export function square(lon: number, lat: number, size = 0.1) {
  const east = round9(lon + size);
  const north = round9(lat + size);
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [east, lat],
        [east, north],
        [lon, north],
        [lon, lat],
      ],
    ],
  } as const;
}

/** A self-intersecting "bow tie" polygon (ST_IsValid = false). */
export const BOW_TIE = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1.1],
      [104.1, 1],
      [104, 1.1],
      [104, 1],
    ],
  ],
} as const;

/** Off Batam (Singapore Strait). */
export const BATAM_SQUARE = square(104.0, 1.1);
/** Off Gresik/Surabaya (the MVP pipeline area). */
export const SURABAYA_SQUARE = square(112.6, -7.1);

/** A create body for `POST /api/v2/zones`. */
export function zoneBody(overrides: Record<string, unknown> = {}) {
  return {
    code: zoneCode(),
    name: 'Test zone',
    kind: 'restricted',
    geometry: BATAM_SQUARE,
    ...overrides,
  };
}

/** The `id` of a created zone response. */
export function idOf(response: TestResponse): string {
  return response.json<{ id: string }>().id;
}
