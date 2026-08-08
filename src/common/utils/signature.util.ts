import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies an HMAC-SHA256 webhook signature against the raw request body.
 * The `rawBody` (Buffer/string) must be the exact bytes received — see the
 * `rawBody` capture wired up in main.ts.
 *
 * Accepts signatures with or without a `sha256=` prefix and is constant-time.
 */
export function verifyHmacSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const provided = signatureHeader.replace(/^sha256=/i, '').trim();
  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
