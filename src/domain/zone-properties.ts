import { issuesToFieldErrors } from '@darmawanweb/ais-its-contracts/api';
import {
  ZONE_PROPERTY_SCHEMAS,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';

/** Largest accepted `properties` object, bytes of its JSON text (64 KiB). */
export const ZONE_PROPERTIES_MAX_BYTES = 64 * 1024;

/**
 * Keys reserved for columns of the zone: the provenance lives in the
 * top-level `source` field (column `source`) and is merged into the published
 * snapshot's `properties.source`, so it cannot also be sent here.
 */
const RESERVED_KEYS = ['source'] as const;

/**
 * Validates the kind-specific `properties` of a zone on write with the
 * contracts schema of its kind (`ZONE_PROPERTY_SCHEMAS`): known keys must be
 * valid (e.g. pipeline `markers[]` of `{ name, lat, lon }`), unknown keys are
 * kept so new keys need no release of this service. Unlike the lenient
 * contracts reader `zoneProperties()`, invalid values are refused, never
 * dropped.
 *
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with `properties.*` field errors.
 */
export function parseZoneProperties(
  kind: ZoneKind,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const reserved = RESERVED_KEYS.filter((key) => Object.hasOwn(input, key));
  if (reserved.length > 0) {
    throw new ValidationFailedError(
      reserved.map((key) => ({
        field: `properties.${key}`,
        message: `properties.${key} is reserved: use the top-level field "${key}"`,
        code: 'reserved',
      })),
    );
  }
  const size = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (size > ZONE_PROPERTIES_MAX_BYTES) {
    throw new ValidationFailedError([
      {
        field: 'properties',
        message: `properties must be at most ${ZONE_PROPERTIES_MAX_BYTES} bytes of JSON (got ${size})`,
        code: 'maxSize',
      },
    ]);
  }
  const result = ZONE_PROPERTY_SCHEMAS[kind].safeParse(input);
  if (!result.success) {
    throw new ValidationFailedError(
      issuesToFieldErrors(result.error.issues).map((error) => ({
        ...error,
        field: error.field === '' ? 'properties' : `properties.${error.field}`,
      })),
      `Invalid properties for a ${kind} zone`,
    );
  }
  return { ...result.data };
}
