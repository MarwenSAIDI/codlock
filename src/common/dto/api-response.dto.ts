import { ApiProperty } from '@nestjs/swagger';

/**
 * Uniform response envelope enforced by ResponseInterceptor and
 * AllExceptionsFilter: `{ success, data, error?, meta }`.
 */
export class ApiResponse<T> {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ nullable: true })
  data: T | null;

  @ApiProperty({ required: false, nullable: true, example: null })
  error?: string | null;

  @ApiProperty({
    example: { timestamp: '2026-08-08T10:00:00.000Z', path: '/api/v1/orders' },
  })
  meta: {
    timestamp: string;
    path?: string;
    requestId?: string;
  };

  static ok<T>(data: T, path?: string, requestId?: string): ApiResponse<T> {
    return {
      success: true,
      data,
      error: null,
      meta: { timestamp: new Date().toISOString(), path, requestId },
    };
  }

  static fail(error: string, path?: string, requestId?: string): ApiResponse<null> {
    return {
      success: false,
      data: null,
      error,
      meta: { timestamp: new Date().toISOString(), path, requestId },
    };
  }
}
