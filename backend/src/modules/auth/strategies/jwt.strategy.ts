import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { isUUID } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedSeller } from '../../../common/decorators/current-seller.decorator';

interface JwtPayload {
  sub?: string;
  email?: string;
  roles?: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const issuer = config.get<string>('jwt.issuer');
    const audience = config.get<string>('jwt.audience');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret') as string,
      algorithms: ['HS256'],
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    });
  }

  /**
   * Return value is attached to `req.user`.
   *
   * `sub` carries the seller id that every tenant-scoped query filters on, so
   * it is validated here rather than trusted. passport-jwt does not require
   * the claim to be present, and an absent or malformed `sub` would otherwise
   * flow into `.eq('seller_id', …)` as the tenant key.
   */
  validate(payload: JwtPayload): AuthenticatedSeller {
    if (!payload.sub || !isUUID(payload.sub)) {
      throw new UnauthorizedException('Token subject is not a valid seller id');
    }
    return {
      sellerId: payload.sub,
      email: payload.email,
      roles: payload.roles ?? ['seller'],
    };
  }
}
