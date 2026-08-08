import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiResponse } from '../dto/api-response.dto';

/**
 * Single funnel for every thrown error. Guarantees the failure envelope
 * matches the success envelope shape, and never leaks stack traces to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string) ?? undefined;

    const { status, message } = this.normalise(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${req.method} ${req.originalUrl} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${req.method} ${req.originalUrl} → ${status}: ${message}`);
    }

    res
      .status(status)
      .json(ApiResponse.fail(message, req.originalUrl, requestId));
  }

  private normalise(exception: unknown): { status: number; message: string } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      // class-validator produces `{ message: string[] }`; flatten it.
      let message: string;
      if (typeof response === 'string') {
        message = response;
      } else {
        const r = response as { message?: string | string[] };
        message = Array.isArray(r.message)
          ? r.message.join('; ')
          : (r.message ?? exception.message);
      }
      return { status, message };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
