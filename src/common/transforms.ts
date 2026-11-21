import type { TransformFnParams } from 'class-transformer';

/** Trims string input before validation (other values pass unchanged). */
export function trimString(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  return typeof input === 'string' ? input.trim() : input;
}

/**
 * Query booleans: `true`/`1` and `false`/`0` become booleans; anything else
 * passes unchanged so `@IsBoolean()` reports it.
 */
export function booleanQuery(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  if (input === 'true' || input === '1') return true;
  if (input === 'false' || input === '0') return false;
  return input;
}

/**
 * Query lists: repeated parameters (`kind=a&kind=b`) and comma separated
 * values (`kind=a,b`) both become `['a', 'b']`; blanks are dropped.
 */
export function listQuery(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  const values = Array.isArray(input) ? (input as unknown[]) : [input];
  if (!values.every((value) => typeof value === 'string')) return input;
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
}
