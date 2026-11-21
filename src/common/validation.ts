import { ValidateIf } from 'class-validator';

/**
 * Marks a request property as optional while refusing `null`: an absent
 * property (`undefined`) skips its validators, `null` is validated like any
 * other value and so fails the type validators (`@IsString()`,
 * `@IsNumber()`, …) with `400 VALIDATION_FAILED`.
 *
 * Use it instead of class-validator's `@IsOptional()` for properties whose
 * column is `NOT NULL`: `@IsOptional()` skips `null` as well, which would let
 * `{ "bufferM": null }` through to the database. Keep `@IsOptional()` only
 * where `null` is a meaningful value (e.g. `source: null` clears it).
 */
export function IsOptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined);
}
