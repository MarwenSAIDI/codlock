import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/** Structured request/response timing logs, one line in and one line out. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { method, originalUrl } = req;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - startedAt;
          this.logger.log(`${method} ${originalUrl} ${res.statusCode} +${ms}ms`);
        },
        error: (err) => {
          const ms = Date.now() - startedAt;
          this.logger.warn(
            `${method} ${originalUrl} FAILED +${ms}ms — ${err?.message ?? err}`,
          );
        },
      }),
    );
  }
}
