import { describe, expect, it } from 'vitest';

import { missingTilesGrants } from './tiles-grants.js';

describe('missingTilesGrants', () => {
  it('grants only what is missing on objects that exist', () => {
    expect(
      missingTilesGrants(
        { schemaUsage: false, viewSelect: false, functionExecute: false },
        '"geo"',
      ),
    ).toEqual([
      'GRANT USAGE ON SCHEMA "geo" TO tiles_ro',
      'GRANT SELECT ON "geo".zones_tiles TO tiles_ro',
      'GRANT EXECUTE ON FUNCTION "geo".zones_tiles_mvt(integer, integer, integer) TO tiles_ro',
    ]);
    expect(
      missingTilesGrants(
        { schemaUsage: true, viewSelect: true, functionExecute: false },
        '"geo"',
      ),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION "geo".zones_tiles_mvt(integer, integer, integer) TO tiles_ro',
    ]);
  });

  it('grants nothing when everything is in place or not migrated yet', () => {
    expect(
      missingTilesGrants(
        { schemaUsage: true, viewSelect: true, functionExecute: true },
        '"geo"',
      ),
    ).toEqual([]);
    expect(
      missingTilesGrants(
        { schemaUsage: true, viewSelect: null, functionExecute: null },
        '"geo"',
      ),
    ).toEqual([]);
  });
});
