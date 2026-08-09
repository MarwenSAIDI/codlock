import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  WEBHOOK_SIGNATURE_KEY,
  WebhookSignatureConfig,
} from '../decorators/webhook-signature.decorator';
import { verifyHmacSignature } from '../utils/signature.util';

/**
 * Verifies a webhook's HMAC-SHA256 signature over the raw request body.
 *
 * Being a guard, this runs BEFORE the global ValidationPipe — so a request with
 * a missing, malformed, or wrong signature is rejected with 401 before any DTO
 * validation runs. Previously verification lived inside the controller body,
 * which meant unauthenticated callers received a 400 enumerating the entire
 * expected payload schema.
 *
 * Requires the raw-body capture configured in main.ts.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const cfg = this.reflector.getAllAndOverride<WebhookSignatureConfig>(
      WEBHOOK_SIGNATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!cfg) {
      // A guarded route with no config is a wiring mistake — fail closed.
      throw new UnauthorizedException('Webhook signature not configured');
    }

    const secret = this.config.get<string>(cfg.secretKey);
    if (!secret) {
      throw new BadRequestException('Webhook secret not configured');
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    const signature = req.headers[cfg.header.toLowerCase()];
    const provided = Array.isArray(signature) ? signature[0] : signature;

    // Verify against the exact received bytes; fall back to a re-serialisation
    // only if rawBody is somehow absent (it is enabled globally in main.ts).
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    if (!verifyHmacSignature(raw, provided, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return true;
  }
}
