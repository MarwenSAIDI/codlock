import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as publicly reachable, bypassing the global JwtAuthGuard.
 * Use on webhooks and health checks.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
