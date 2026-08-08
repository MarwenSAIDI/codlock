import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { ApiResponse } from '../dto/api-response.dto';

/**
 * Wraps every successful controller return value in the standard
 * `{ success, data, error, meta }` envelope. Controllers therefore return
 * plain payloads — never the envelope themselves.
 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const req = context.switchToHttp().getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string) ?? undefined;

    return next
      .handle()
      .pipe(map((data) => ApiResponse.ok(data, req.originalUrl, requestId)));
  }
}
