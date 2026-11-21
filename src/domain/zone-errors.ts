import type { GeometryType, ZoneKind } from '@darmawanweb/ais-its-contracts/domain';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';

/**
 * Business errors of the zones registry. Each has a stable code
 * (`ProblemDetails.code`) and is rendered as RFC 9457 problem details by the
 * kit's filter; 400 structural GeoJSON problems use the kit's
 * `ValidationFailedError` instead (field-level `errors`).
 */

/** `404 ZONE_NOT_FOUND` (shared contracts code): unknown or not visible to the principal. */
export class ZoneNotFoundError extends NotFoundError {
  override readonly name = 'ZoneNotFoundError';

  constructor(id: string) {
    super(`No zone with id ${id}`, { code: 'ZONE_NOT_FOUND', extra: { id } });
  }
}

/** `409 ZONE_CODE_TAKEN`: the code is already used by the same owner (global or organization). */
export class ZoneCodeTakenError extends ConflictError {
  override readonly name = 'ZoneCodeTakenError';

  constructor(code: string, orgId: string | null, cause?: unknown) {
    super(
      orgId === null
        ? `A global zone with code "${code}" already exists`
        : `The organization already has a zone with code "${code}"`,
      { code: 'ZONE_CODE_TAKEN', extra: { zoneCode: code, orgId }, cause },
    );
  }
}

/** `403 GLOBAL_ZONE_WRITE_FORBIDDEN`: global zones are written by `super_admin` / `authority` only. */
export class GlobalZoneWriteForbiddenError extends ForbiddenError {
  override readonly name = 'GlobalZoneWriteForbiddenError';

  constructor() {
    super(
      'Only super_admin and authority users may create, change or delete global zones',
      { code: 'GLOBAL_ZONE_WRITE_FORBIDDEN' },
    );
  }
}

/** `403 ZONE_WRITE_FORBIDDEN`: the zone belongs to another organization (visible, not writable). */
export class ZoneWriteForbiddenError extends ForbiddenError {
  override readonly name = 'ZoneWriteForbiddenError';

  constructor(id: string) {
    super(
      `Zone ${id} belongs to another organization: only its own organization may change it`,
      { code: 'ZONE_WRITE_FORBIDDEN', extra: { id } },
    );
  }
}

/** `403 ORGANIZATION_REQUIRED`: organization zones need an active organization. */
export class OrganizationRequiredError extends ForbiddenError {
  override readonly name = 'OrganizationRequiredError';

  constructor() {
    super(
      'Select an organization to manage its zones (or create a global zone)',
      { code: 'ORGANIZATION_REQUIRED' },
    );
  }
}

/** `403 PLATFORM_ADMIN_REQUIRED`: the operation is reserved to `super_admin`. */
export class PlatformAdminRequiredError extends ForbiddenError {
  override readonly name = 'PlatformAdminRequiredError';

  constructor(operation: string) {
    super(`Only super_admin may ${operation}`, {
      code: 'PLATFORM_ADMIN_REQUIRED',
    });
  }
}

/** `422 ZONE_GEOMETRY_TYPE_NOT_ALLOWED`: the geometry type does not fit the zone kind. */
export class ZoneGeometryTypeNotAllowedError extends DomainError {
  override readonly name = 'ZoneGeometryTypeNotAllowedError';

  constructor(
    kind: ZoneKind,
    geometryType: GeometryType,
    allowed: readonly GeometryType[],
  ) {
    super('ZONE_GEOMETRY_TYPE_NOT_ALLOWED', {
      status: 422,
      title: 'Geometry type not allowed for the zone kind',
      detail: `A ${kind} zone cannot be a ${geometryType}; allowed: ${allowed.join(', ')}`,
      extra: { kind, geometryType, allowedGeometryTypes: [...allowed] },
    });
  }
}

/** `422 ZONE_GEOMETRY_TOO_COMPLEX`: more vertices than the registry accepts. */
export class ZoneGeometryTooComplexError extends DomainError {
  override readonly name = 'ZoneGeometryTooComplexError';

  constructor(vertices: number, maxVertices: number) {
    super('ZONE_GEOMETRY_TOO_COMPLEX', {
      status: 422,
      title: 'Zone geometry has too many vertices',
      detail: `The geometry has ${vertices} vertices; at most ${maxVertices} are accepted. Simplify it (e.g. ST_SimplifyPreserveTopology or QGIS "Simplify") and submit it again`,
      extra: { vertices, maxVertices },
    });
  }
}

/** `422 ZONE_BUFFER_REQUIRED`: a point zone without a buffer has no extent. */
export class ZoneBufferRequiredError extends DomainError {
  override readonly name = 'ZoneBufferRequiredError';

  constructor(geometryType: GeometryType) {
    super('ZONE_BUFFER_REQUIRED', {
      status: 422,
      title: 'Zone buffer required',
      detail: `A ${geometryType} zone needs bufferM > 0 (the radius of the zone around its points)`,
      extra: { geometryType },
    });
  }
}

/** Result of PostGIS `ST_IsValidDetail` for a candidate geometry. */
export interface GeometryValidity {
  readonly valid: boolean;
  /** GEOS reason, e.g. `Self-intersection`; `null` when valid. */
  readonly reason: string | null;
  /** `[lon, lat]` where the problem was found, when GEOS reports one. */
  readonly location: readonly [number, number] | null;
}

/**
 * `422 ZONE_GEOMETRY_INVALID`: PostGIS `ST_IsValid` rejected the geometry
 * (OGC Simple Features validity). The service never repairs geometries
 * silently: the message tells where the problem is and how to fix it.
 */
export class ZoneGeometryInvalidError extends DomainError {
  override readonly name = 'ZoneGeometryInvalidError';

  constructor(validity: GeometryValidity) {
    const where =
      validity.location === null
        ? ''
        : ` at or near [${validity.location.map((value) => value.toFixed(6)).join(', ')}]`;
    super('ZONE_GEOMETRY_INVALID', {
      status: 422,
      title: 'Invalid zone geometry',
      detail: `${validity.reason ?? 'Invalid geometry'}${where}. The geometry must be valid (OGC Simple Features, PostGIS ST_IsValid); fix it, e.g. with QGIS "Fix geometries" or PostGIS ST_MakeValid, and submit it again: it is not repaired automatically`,
      extra: {
        reason: validity.reason,
        location: validity.location === null ? null : [...validity.location],
      },
    });
  }
}
