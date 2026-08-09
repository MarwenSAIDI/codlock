import { SetMetadata } from '@nestjs/common';

export const WEBHOOK_SIGNATURE_KEY = 'webhookSignature';

export interface WebhookSignatureConfig {
  /** Request header carrying the HMAC-SHA256 hex digest. */
  header: string;
  /** ConfigService key holding the shared secret (e.g. `gravv.webhookSecret`). */
  secretKey: string;
}

/**
 * Declares that a route is authenticated by an HMAC signature over the raw
 * request body, checked by WebhookSignatureGuard. The guard runs before the
 * ValidationPipe, so an unauthenticated caller is rejected before any DTO
 * parsing occurs and never sees the payload schema.
 */
export const WebhookSignature = (config: WebhookSignatureConfig) =>
  SetMetadata(WEBHOOK_SIGNATURE_KEY, config);
