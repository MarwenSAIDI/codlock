import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedSeller {
  sellerId: string;
  email?: string;
  roles?: string[];
}

/**
 * Extracts the authenticated seller injected by JwtStrategy onto the request.
 * Usage: `@CurrentSeller() seller: AuthenticatedSeller`
 */
export const CurrentSeller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedSeller => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthenticatedSeller;
  },
);
