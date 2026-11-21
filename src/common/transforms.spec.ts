import type { TransformFnParams } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { booleanQuery, listQuery, trimString } from './transforms.js';

/** The parameters class-transformer passes for `value`. */
function params(value: unknown): TransformFnParams {
  return { value } as TransformFnParams;
}

describe('query transforms', () => {
  it('trims strings only', () => {
    expect(trimString(params('  a  '))).toBe('a');
    expect(trimString(params(3))).toBe(3);
  });

  it('parses query booleans and leaves other values for validation', () => {
    expect(booleanQuery(params('true'))).toBe(true);
    expect(booleanQuery(params('0'))).toBe(false);
    expect(booleanQuery(params('yes'))).toBe('yes');
  });

  it('splits comma separated and repeated values', () => {
    expect(listQuery(params('a, b,,c'))).toEqual(['a', 'b', 'c']);
    expect(listQuery(params(['a,b', 'c']))).toEqual(['a', 'b', 'c']);
    expect(listQuery(params(5))).toBe(5);
  });
});
