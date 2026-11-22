import { ValidationFailedError } from '@darmawanweb/ais-its-nest';

import type { Zone } from './zone.js';
import { ZoneVersionConflictError } from './zone-errors.js';

/**
 * Optimistic concurrency of zone writes (RFC 9110 §8.8.3 `ETag`, §13.1.1
 * `If-Match`). The version of a zone is its `updatedAt`, which strictly
 * increases with every change (at least 1 ms, see `ZoneUnitOfWork.update`),
 * so the entity tag is the quoted ISO-8601 instant: clients may also build
 * it from the `updatedAt` of a list item.
 */

/** A parsed `If-Match` header. */
export type IfMatch =
  | { readonly kind: 'any' }
  | {
      readonly kind: 'tags';
      /** Opaque strong tags without quotes; weak tags never match (RFC 9110 §13.1.1). */
      readonly tags: readonly string[];
    };

/** The strong entity tag of a zone version, e.g. `"2026-11-21T10:00:00.123Z"`. */
export function zoneEtag(zone: Pick<Zone, 'updatedAt'>): string {
  return `"${zone.updatedAt.toISOString()}"`;
}

/** `entity-tag = [ "W/" ] DQUOTE *etagc DQUOTE` (RFC 9110 §8.8.3). */
const ENTITY_TAG = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/;

/**
 * Parses an `If-Match` header: `*` or a comma-separated list of entity tags.
 *
 * @returns `undefined` when the header is absent or empty (no precondition).
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` for a malformed value.
 */
export function parseIfMatch(header: string | undefined): IfMatch | undefined {
  const value = header?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === '*') return { kind: 'any' };
  const tags: string[] = [];
  for (const member of value.split(',')) {
    const match = ENTITY_TAG.exec(member.trim());
    if (match === null) {
      throw new ValidationFailedError(
        [
          {
            field: 'If-Match',
            message:
              'If-Match must be * or a list of quoted entity tags, e.g. "2026-11-21T10:00:00.123Z"',
            code: 'invalid_if_match',
          },
        ],
        'Invalid If-Match header',
      );
    }
    // Weak tags are parsed (valid syntax) but never match strongly.
    if (match[1] === undefined && match[2] !== undefined) tags.push(match[2]);
  }
  return { kind: 'tags', tags };
}

/** `true` when the precondition holds for the current entity tag (strong comparison). */
export function ifMatchSatisfied(
  condition: IfMatch | undefined,
  currentEtag: string,
): boolean {
  if (condition === undefined || condition.kind === 'any') return true;
  return condition.tags.some((tag) => `"${tag}"` === currentEtag);
}

/**
 * Throws unless the `If-Match` precondition holds for the stored zone
 * (checked on the row locked by the write transaction).
 *
 * @throws {ZoneVersionConflictError} `412 ZONE_VERSION_CONFLICT`
 */
export function assertZoneVersion(
  condition: IfMatch | undefined,
  zone: Pick<Zone, 'id' | 'updatedAt'>,
): void {
  const current = zoneEtag(zone);
  if (!ifMatchSatisfied(condition, current)) {
    throw new ZoneVersionConflictError(zone.id, current);
  }
}
