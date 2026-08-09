/**
 * Drive the agent over real A2A JSON-RPC, the way the orchestrator will.
 *
 * Through the HTTP surface rather than the service directly, because the thing most
 * likely to break on Sunday is the wire, not the arithmetic.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const config = { ...loadConfig({}), stubMode: true, geminiApiKey: undefined };
  server = createApp(config).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** One A2A skill call. Mirrors exactly what the orchestrator has to send. */
async function call(skill: string, input: unknown): Promise<any> {
  return send([{ data: { skill, input } }]);
}

/** A plain-text delegation, the way google-adk's RemoteA2aAgent sends one. */
async function callText(text: string): Promise<any> {
  return send([{ text }]);
}

async function send(parts: unknown[]): Promise<any> {
  const response = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Mandatory. Without it the server rejects the call as protocol 0.3.
      'A2A-Version': '1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'SendMessage',
      params: {
        message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts },
      },
    }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as any;
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result.message.parts[0].data;
}

const ORDER = {
  order_id: 'ord_demo_1',
  seller_id: 'S456',
  customer: {
    customer_id: 'C123',
    full_name: 'Amira Ben Salah',
    phone: '+21620123456',
    zone: 'Ariana',
  },
  order_total: { amount: '149.000', currency: 'TND' },
  deposit: { amount: '29.800', currency: 'TND' },
  deposit_rate: 0.2,
  risk_score: 32,
  channel: 'instagram',
};

describe('discovery', () => {
  it('advertises its skills on the agent card', async () => {
    const card = (await (await fetch(`${baseUrl}/.well-known/agent-card.json`)).json()) as any;
    expect(card.name).toBe('CODLOCK Payment Agent');
    expect(card.skills.map((s: any) => s.id).sort()).toEqual([
      'collect_deposit', 'confirm_payment', 'settle_order',
    ]);
  });

  it('answers a health probe', async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as any;
    expect(health.status).toBe('ok');
  });
});

describe('deposit lifecycle', () => {
  it('runs from checkout through polling to settlement', async () => {
    const opened = await call('collect_deposit', ORDER);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(opened.output.status).toBe('awaiting_payment');
    expect(opened.output.checkout_url).toBeTruthy();

    const ids = {
      payment_id: opened.output.payment_id,
      order_id: opened.output.order_id,
    };

    const first = await call('confirm_payment', ids);
    expect(first.output.status).toBe('awaiting_payment');

    // The stub clears on the second poll, so the orchestrator must actually poll.
    let latest = first;
    for (let i = 0; i < 5 && latest.output.status !== 'paid'; i += 1) {
      latest = await call('confirm_payment', ids);
    }
    expect(latest.output.status).toBe('paid');
    expect(latest.output.paid.amount).toBe('29.800');

    const settled = await call('settle_order', {
      ...ids, outcome: 'refused', courier_fee: { amount: '8.000', currency: 'TND' },
    });
    expect(settled.output.disposition).toBe('retained_for_courier');
    expect(settled.output.seller_shortfall.amount).toBe('0.000');
  });

  it('never touches Gravv for a zero deposit', async () => {
    const result = await call('collect_deposit', {
      ...ORDER, order_id: 'ord_clean_customer',
      deposit: { amount: '0', currency: 'TND' }, deposit_rate: 0, risk_score: 4,
    });
    expect(result.output.status).toBe('not_required');
    expect(result.output.checkout_url).toBeNull();
  });

  it('is idempotent on order_id', async () => {
    const payload = { ...ORDER, order_id: 'ord_retry' };
    const first = await call('collect_deposit', payload);
    const second = await call('collect_deposit', payload);
    expect(second.output.payment_id).toBe(first.output.payment_id);
    expect(second.output.checkout_url).toBe(first.output.checkout_url);
  });
});

describe('errors are structured, never crashes', () => {
  it('rejects invalid input', async () => {
    const result = await call('collect_deposit', { order_id: 'ord_x' });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('invalid_input');
  });

  it('rejects a float amount, which would lose millimes', async () => {
    const result = await call('collect_deposit', {
      ...ORDER, order_id: 'ord_float', deposit: { amount: 29.8, currency: 'TND' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('invalid_input');
  });

  it('lists known skills when asked for an unknown one', async () => {
    const result = await call('does_not_exist', {});
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('collect_deposit');
  });

  it('fails loudly when settling an order it never saw', async () => {
    const result = await call('settle_order', {
      order_id: 'ord_never_seen', payment_id: 'pay_nope', outcome: 'accepted',
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('LookupError');
  });
});

describe('natural-language delegation (google-adk RemoteA2aAgent)', () => {
  it('accepts a JSON envelope pasted into a text part, with no model involved', async () => {
    const result = await callText(
      JSON.stringify({ skill: 'collect_deposit', input: { ...ORDER, order_id: 'ord_text_json' } }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.output.status).toBe('awaiting_payment');
  });

  it('refuses to guess when free text arrives and no extractor is configured', async () => {
    // Inventing a deposit from an unparsed sentence is worse than saying it cannot
    // read the sentence.
    const result = await callText('Please collect a deposit for that dress order.');
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('extraction_failed');
    expect(result.error.message).toContain('GEMINI_API_KEY');
  });

  it('explains itself when a message carries nothing at all', async () => {
    const result = await send([]);
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('missing_skill');
  });
});
