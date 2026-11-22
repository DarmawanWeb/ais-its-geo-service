import { describe, expect, it } from 'vitest';

import {
  assertZoneVersion,
  ifMatchSatisfied,
  parseIfMatch,
  zoneEtag,
} from './zone-version.js';

const ZONE = {
  id: '01900000-0000-7000-8000-000000000001',
  updatedAt: new Date('2026-11-21T10:00:00.123Z'),
};
const CURRENT = '"2026-11-21T10:00:00.123Z"';

describe('zoneEtag', () => {
  it('is the quoted ISO-8601 updatedAt (strong entity tag)', () => {
    expect(zoneEtag(ZONE)).toBe(CURRENT);
  });
});

describe('parseIfMatch', () => {
  it('reads no precondition from an absent or blank header', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('  ')).toBeUndefined();
  });

  it('reads *, one tag or a list; weak tags never match', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' });
    expect(parseIfMatch(CURRENT)).toEqual({
      kind: 'tags',
      tags: ['2026-11-21T10:00:00.123Z'],
    });
    expect(parseIfMatch(` "a" , W/"b", ${CURRENT}`)).toEqual({
      kind: 'tags',
      tags: ['a', '2026-11-21T10:00:00.123Z'],
    });
  });

  it('refuses malformed values with 400', () => {
    for (const value of ['2026-11-21', '"a', 'a, "b"', '"a"b"']) {
      expect(() => parseIfMatch(value)).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'VALIDATION_FAILED',
        }) as Error,
      );
    }
  });
});

describe('ifMatchSatisfied / assertZoneVersion', () => {
  it('holds without a precondition, for * and for the current tag', () => {
    expect(ifMatchSatisfied(undefined, CURRENT)).toBe(true);
    expect(ifMatchSatisfied({ kind: 'any' }, CURRENT)).toBe(true);
    expect(ifMatchSatisfied(parseIfMatch(`"x", ${CURRENT}`), CURRENT)).toBe(
      true,
    );
    expect(() => {
      assertZoneVersion(parseIfMatch(CURRENT), ZONE);
    }).not.toThrow();
  });

  it('fails for another version (or only a weak tag) with 412 ZONE_VERSION_CONFLICT', () => {
    expect(ifMatchSatisfied(parseIfMatch(`W/${CURRENT}`), CURRENT)).toBe(false);
    expect(() => {
      assertZoneVersion(parseIfMatch('"2026-11-21T09:59:59.000Z"'), ZONE);
    }).toThrow(
      expect.objectContaining({
        status: 412,
        code: 'ZONE_VERSION_CONFLICT',
        extra: { id: ZONE.id, currentEtag: CURRENT },
      }) as Error,
    );
  });
});
