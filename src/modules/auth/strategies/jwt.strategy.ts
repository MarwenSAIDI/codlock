import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedSeller } from '../../../common/decorators/current-seller.decorator';

interface JwtPayload {
  sub: string;
  email?: string;
  roles?: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret') as string,
    });
  }

  /** Return value is attached to `req.user`. */
  validate(payload: JwtPayload): AuthenticatedSeller {
    return {
      sellerId: payload.sub,
      email: payload.email,
      roles: payload.roles ?? ['seller'],
    };
  }
}
