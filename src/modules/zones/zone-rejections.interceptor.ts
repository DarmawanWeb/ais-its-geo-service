import { DomainError } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Counter } from 'prom-client';
import { catchError, type Observable, throwError } from 'rxjs';

/**
 * Statuses of refused zone writes: invalid input (400 — DTO validation by
 * the global `ValidationPipe` included —, 422), conflicts with the stored
 * state (409 code taken or quota exceeded, 412 stale `If-Match`).
 * Authentication, permission and visibility problems (401, 403, 404) are not
 * refusals of the input; the HTTP metrics count them.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 412, 422]);

/** `true` for a problem that refuses a zone write because of its input or the registry state. */
export function isZoneWriteRefusal(error: unknown): error is DomainError {
  return error instanceof DomainError && REFUSAL_STATUSES.has(error.status);
}

/**
 * Counts refused zone writes by problem code,
 * `aisits_geo_zone_rejections_total{code}`. As an interceptor of the write
 * routes it also sees the `400 VALIDATION_FAILED` raised by the global
 * `ValidationPipe` before the handler runs (pipes run inside the
 * interceptor chain).
 */
@Injectable()
export class ZoneRejectionsInterceptor implements NestInterceptor {
  private readonly rejections: Counter<'code'>;

  constructor(metrics: MetricsService) {
    this.rejections = metrics.counter({
      name: 'geo_zone_rejections_total',
      help: 'Zone writes refused (400/409/412/422, DTO validation included), by problem code.',
      labelNames: ['code'],
    });
  }

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (isZoneWriteRefusal(error))
          this.rejections.inc({ code: error.code });
        return throwError(() => error);
      }),
    );
  }
}
