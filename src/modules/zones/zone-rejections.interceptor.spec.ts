import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  ZoneGeometryInvalidError,
  ZoneVersionConflictError,
} from '../../domain/zone-errors.js';
import {
  isZoneWriteRefusal,
  ZoneRejectionsInterceptor,
} from './zone-rejections.interceptor.js';

const CONTEXT = {} as ExecutionContext;

function failing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('isZoneWriteRefusal', () => {
  it('is true for input and state refusals (400, 409, 412, 422)', () => {
    expect(isZoneWriteRefusal(new ValidationFailedError([]))).toBe(true);
    expect(isZoneWriteRefusal(new ConflictError('taken'))).toBe(true);
    expect(isZoneWriteRefusal(new ZoneVersionConflictError('id', '"v"'))).toBe(
      true,
    );
    expect(
      isZoneWriteRefusal(
        new ZoneGeometryInvalidError({
          valid: false,
          reason: 'Self-intersection',
          location: null,
        }),
      ),
    ).toBe(true);
  });

  it('is false for access problems and unexpected errors', () => {
    expect(isZoneWriteRefusal(new ForbiddenError('no'))).toBe(false);
    expect(isZoneWriteRefusal(new NotFoundError('gone'))).toBe(false);
    expect(isZoneWriteRefusal(new Error('boom'))).toBe(false);
  });
});

describe('ZoneRejectionsInterceptor', () => {
  it('counts refusals by code, DTO validation included, and rethrows them', async () => {
    const metrics = new MetricsService();
    const interceptor = new ZoneRejectionsInterceptor(metrics);
    const refusal = new ValidationFailedError([
      { field: 'code', message: 'code must match', code: 'matches' },
    ]);

    await expect(
      lastValueFrom(interceptor.intercept(CONTEXT, failing(refusal))),
    ).rejects.toBe(refusal);
    await expect(
      lastValueFrom(
        interceptor.intercept(CONTEXT, failing(new ForbiddenError('no'))),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      lastValueFrom(
        interceptor.intercept(CONTEXT, { handle: () => of('created') }),
      ),
    ).resolves.toBe('created');

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'aisits_geo_zone_rejections_total{code="VALIDATION_FAILED"} 1',
    );
    expect(text).not.toContain('code="FORBIDDEN"');
  });
});
