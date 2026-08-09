import { createHmac } from 'crypto';
import { verifyHmacSignature } from './signature.util';

/**
 * This helper is the only thing standing between the public internet and the
 * order/payment mutation paths (`/webhooks/chat/order`, `/payments/gravv/webhook`),
 * so the rejection cases matter more than the happy path.
 */
describe('verifyHmacSignature', () => {
  const secret = 'super-secret-webhook-key';
  const body = JSON.stringify({ eventId: 'evt_1', amount: 29.8 });
  const sign = (payload: string | Buffer, key = secret): string =>
    createHmac('sha256', key).update(payload).digest('hex');

  it('accepts a correct signature over the raw body', () => {
    expect(verifyHmacSignature(body, sign(body), secret)).toBe(true);
  });

  it('accepts the same signature with a `sha256=` prefix', () => {
    expect(verifyHmacSignature(body, `sha256=${sign(body)}`, secret)).toBe(
      true,
    );
    expect(verifyHmacSignature(body, `SHA256=${sign(body)}`, secret)).toBe(
      true,
    );
  });

  it('accepts a Buffer body identical to the signed bytes', () => {
    const raw = Buffer.from(body, 'utf8');
    expect(verifyHmacSignature(raw, sign(raw), secret)).toBe(true);
  });

  it('rejects a signature produced with a different secret', () => {
    expect(verifyHmacSignature(body, sign(body, 'wrong-key'), secret)).toBe(
      false,
    );
  });

  it('rejects when the body was altered after signing', () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ eventId: 'evt_1', amount: 2980 });
    expect(verifyHmacSignature(tampered, signature, secret)).toBe(false);
  });

  it('rejects a single-byte body change', () => {
    const signature = sign(body);
    expect(verifyHmacSignature(`${body} `, signature, secret)).toBe(false);
  });

  it('rejects a missing or empty signature header', () => {
    expect(verifyHmacSignature(body, undefined, secret)).toBe(false);
    expect(verifyHmacSignature(body, '', secret)).toBe(false);
  });

  it('rejects everything when the secret is not configured', () => {
    expect(verifyHmacSignature(body, sign(body, ''), '')).toBe(false);
  });

  it('rejects a truncated signature of otherwise-correct bytes', () => {
    expect(verifyHmacSignature(body, sign(body).slice(0, 32), secret)).toBe(
      false,
    );
  });

  it('rejects non-hex garbage without throwing', () => {
    expect(() =>
      verifyHmacSignature(body, 'not-a-hex-signature', secret),
    ).not.toThrow();
    expect(verifyHmacSignature(body, 'not-a-hex-signature', secret)).toBe(
      false,
    );
    expect(verifyHmacSignature(body, 'zz'.repeat(32), secret)).toBe(false);
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(verifyHmacSignature(body, `  ${sign(body)}  `, secret)).toBe(true);
  });
});
