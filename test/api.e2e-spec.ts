import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  OTHER_SELLER_ID,
  SELLER_ID,
  TestContext,
  createTestApp,
  seedCustomer,
  seedProduct,
} from './utils/test-app';

const API = '/api/v1';
const GRAVV_SECRET = 'e2e-gravv-webhook-secret';
const SOCIAL_SECRET = 'e2e-social-webhook-secret';

describe('CODLOCK API (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let auth: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    auth = `Bearer ${ctx.token()}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  // ── Cross-cutting ────────────────────────────────────────────

  describe('envelope + routing', () => {
    it('serves health publicly under the versioned prefix', async () => {
      const res = await http().get(`${API}/health`).expect(200);

      expect(res.body).toMatchObject({
        success: true,
        error: null,
        data: { status: 'ok', orchestrator: { reachable: true } },
      });
      expect(res.body.meta).toMatchObject({ path: `${API}/health` });
      expect(typeof res.body.meta.timestamp).toBe('string');
    });

    it('404s outside the global prefix', async () => {
      await http().get('/health').expect(404);
    });

    it('wraps failures in the same envelope shape', async () => {
      const res = await http().get(`${API}/orders`).expect(401);

      expect(res.body).toMatchObject({ success: false, data: null });
      expect(typeof res.body.error).toBe('string');
      expect(res.body.meta.path).toBe(`${API}/orders`);
    });

    it('echoes a supplied x-request-id into meta', async () => {
      const res = await http()
        .get(`${API}/health`)
        .set('x-request-id', 'req-abc-123')
        .expect(200);

      expect(res.body.meta.requestId).toBe('req-abc-123');
    });
  });

  describe('authentication', () => {
    it.each([
      ['orders', 'get', `${API}/orders`],
      ['products', 'get', `${API}/products`],
      ['customers', 'get', `${API}/customers`],
      ['analytics', 'get', `${API}/analytics/kpis`],
      ['risk', 'post', `${API}/risk/evaluate`],
      ['fitting', 'post', `${API}/fitting/generate-preview`],
    ])('rejects anonymous access to %s', async (_name, method, url) => {
      await (http() as any)[method](url).expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const forged = ctx.token();
      const tampered = `${forged.slice(0, -4)}AAAA`;
      await http()
        .get(`${API}/orders`)
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('rejects a token whose sub is not a UUID', async () => {
      const token = ctx.token('not-a-uuid');
      await http()
        .get(`${API}/orders`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('rejects a token with no sub claim at all', async () => {
      const token = ctx.token(undefined, { sub: undefined });
      await http()
        .get(`${API}/orders`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('accepts a well-formed token', async () => {
      await http().get(`${API}/orders`).set('Authorization', auth).expect(200);
    });
  });

  describe('validation pipe', () => {
    it('rejects unknown properties', async () => {
      seedCustomer(ctx.store);
      const res = await http()
        .post(`${API}/customers`)
        .set('Authorization', auth)
        .send({ phone: '+21629000111', sneaky: 'value' })
        .expect(400);

      expect(res.body.error).toMatch(/sneaky/);
    });

    it('rejects a malformed uuid path param', async () => {
      await http()
        .get(`${API}/orders/not-a-uuid`)
        .set('Authorization', auth)
        .expect(400);
    });

    it('flattens class-validator messages into the error string', async () => {
      const res = await http()
        .post(`${API}/risk/evaluate`)
        .set('Authorization', auth)
        .send({ customerId: 'nope', orderValue: -5 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/customerId/);
      expect(res.body.error).toMatch(/orderValue/);
    });
  });

  // ── Products ─────────────────────────────────────────────────

  describe('products', () => {
    it('creates, reads, updates and deletes', async () => {
      const created = await http()
        .post(`${API}/products`)
        .set('Authorization', auth)
        .send({
          sku: 'DRESS-001',
          title: 'Linen Dress',
          price: 149.9,
          sizes: ['S', 'M'],
          colors: ['beige'],
        })
        .expect(201);

      const id = created.body.data.id;
      expect(created.body.data).toMatchObject({
        seller_id: SELLER_ID,
        sku: 'DRESS-001',
        price: 149.9,
      });

      await http()
        .get(`${API}/products/${id}`)
        .set('Authorization', auth)
        .expect(200);

      const updated = await http()
        .patch(`${API}/products/${id}`)
        .set('Authorization', auth)
        .send({ price: 129.9 })
        .expect(200);
      expect(updated.body.data.price).toBe(129.9);

      await http()
        .delete(`${API}/products/${id}`)
        .set('Authorization', auth)
        .expect(200);

      await http()
        .get(`${API}/products/${id}`)
        .set('Authorization', auth)
        .expect(404);
    });

    it("404s on another seller's product", async () => {
      const product = seedProduct(ctx.store, { seller_id: OTHER_SELLER_ID });
      await http()
        .get(`${API}/products/${product.id}`)
        .set('Authorization', auth)
        .expect(404);
    });

    it('paginates the catalog', async () => {
      for (let i = 0; i < 7; i++) {
        seedProduct(ctx.store, {
          id: `p-${i}`,
          sku: `SKU-${i}`,
          updated_at: `2026-01-0${i + 1}`,
        });
      }

      const page1 = await http()
        .get(`${API}/products?page=1&limit=3`)
        .set('Authorization', auth)
        .expect(200);

      expect(page1.body.data).toMatchObject({
        total: 7,
        page: 1,
        limit: 3,
        hasMore: true,
      });
      expect(page1.body.data.items).toHaveLength(3);

      const page3 = await http()
        .get(`${API}/products?page=3&limit=3`)
        .set('Authorization', auth)
        .expect(200);
      expect(page3.body.data.items).toHaveLength(1);
      expect(page3.body.data.hasMore).toBe(false);
    });

    it('rejects an out-of-range limit', async () => {
      await http()
        .get(`${API}/products?limit=500`)
        .set('Authorization', auth)
        .expect(400);
    });

    it('maps a duplicate SKU to 409, not 500', async () => {
      const body = {
        sku: 'DUP-1',
        title: 'Tee',
        price: 10,
        sizes: ['M'],
        colors: ['black'],
      };
      await http()
        .post(`${API}/products`)
        .set('Authorization', auth)
        .send(body)
        .expect(201);

      const res = await http()
        .post(`${API}/products`)
        .set('Authorization', auth)
        .send(body)
        .expect(409);
      expect(res.body.error).toMatch(/already exists/i);
    });
  });

  // ── Customers ────────────────────────────────────────────────

  describe('customers', () => {
    it('creates and updates a customer', async () => {
      const created = await http()
        .post(`${API}/customers`)
        .set('Authorization', auth)
        .send({ phone: '+21629000111', name: 'Sarra', zone: 'Tunis' })
        .expect(201);

      expect(created.body.data).toMatchObject({
        seller_id: SELLER_ID,
        risk_tier: 'MEDIUM',
        total_orders: 0,
      });

      const updated = await http()
        .patch(`${API}/customers/${created.body.data.id}`)
        .set('Authorization', auth)
        .send({ zone: 'Ariana' })
        .expect(200);
      expect(updated.body.data.zone).toBe('Ariana');
    });

    it('cannot be used to forge risk history', async () => {
      const customer = seedCustomer(ctx.store);
      await http()
        .patch(`${API}/customers/${customer.id}`)
        .set('Authorization', auth)
        .send({ refused_orders: 0, total_orders: 999 })
        .expect(400);
    });

    it("404s on another seller's customer", async () => {
      const customer = seedCustomer(ctx.store, { seller_id: OTHER_SELLER_ID });
      await http()
        .get(`${API}/customers/${customer.id}`)
        .set('Authorization', auth)
        .expect(404);
    });
  });

  // ── Risk ─────────────────────────────────────────────────────

  describe('risk', () => {
    it('returns a tier and deposit from the orchestrator score', async () => {
      const customer = seedCustomer(ctx.store);
      ctx.orchestrator.scoreRisk.mockResolvedValue({
        score: 75,
        factors: { zone: 'high-refusal' },
      });

      const res = await http()
        .post(`${API}/risk/evaluate`)
        .set('Authorization', auth)
        .send({ customerId: customer.id, orderValue: 200 })
        .expect(201);

      expect(res.body.data).toMatchObject({
        score: 75,
        tier: 'HIGH',
        depositRate: 0.2,
        depositAmount: 40,
      });
    });

    it('falls back to the local heuristic when the agent is down', async () => {
      const customer = seedCustomer(ctx.store, {
        total_orders: 10,
        refused_orders: 8,
      });
      ctx.orchestrator.scoreRisk.mockRejectedValue(new Error('circuit open'));

      const res = await http()
        .post(`${API}/risk/evaluate`)
        .set('Authorization', auth)
        .send({ customerId: customer.id, orderValue: 100 })
        .expect(201);

      expect(res.body.data).toMatchObject({
        score: 80,
        tier: 'HIGH',
        factors: { fallback: true },
      });
    });

    it("404s scoring another seller's customer", async () => {
      const customer = seedCustomer(ctx.store, { seller_id: OTHER_SELLER_ID });
      await http()
        .post(`${API}/risk/evaluate`)
        .set('Authorization', auth)
        .send({ customerId: customer.id, orderValue: 100 })
        .expect(404);
    });
  });

  // ── Fitting ──────────────────────────────────────────────────

  describe('fitting', () => {
    it('stores a preview and advances the order', async () => {
      const customer = seedCustomer(ctx.store);
      const product = seedProduct(ctx.store);
      ctx.orchestrator.scoreRisk.mockResolvedValue({ score: 10 });
      ctx.orchestrator.generatePreview.mockResolvedValue({
        previewPhotoUrl: 'https://cdn.codlock.tn/preview/1.jpg',
      });

      const order = await http()
        .post(`${API}/orders`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          channel: 'INSTAGRAM',
          items: [{ productId: product.id, size: 'M', quantity: 1 }],
        })
        .expect(201);

      const res = await http()
        .post(`${API}/fitting/generate-preview`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          productId: product.id,
          orderId: order.body.data.id,
          customerPhotoUrl: 'https://cdn.codlock.tn/u/photo.jpg',
        })
        .expect(201);

      expect(res.body.data.preview_photo_url).toBe(
        'https://cdn.codlock.tn/preview/1.jpg',
      );

      const reloaded = await http()
        .get(`${API}/orders/${order.body.data.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(reloaded.body.data.status).toBe('PREVIEW_GENERATED');

      const sessions = await http()
        .get(`${API}/fitting/order/${order.body.data.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(sessions.body.data).toHaveLength(1);
    });

    it('rejects a product that is not on the order', async () => {
      const customer = seedCustomer(ctx.store);
      const product = seedProduct(ctx.store);
      const other = seedProduct(ctx.store, {
        id: '66666666-6666-4666-8666-666666666666',
        sku: 'OTHER-1',
      });

      const order = await http()
        .post(`${API}/orders`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          channel: 'WHATSAPP',
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(201);

      await http()
        .post(`${API}/fitting/generate-preview`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          productId: other.id,
          orderId: order.body.data.id,
          customerPhotoUrl: 'https://cdn.codlock.tn/u/photo.jpg',
        })
        .expect(400);
    });

    it('surfaces an orchestrator outage as 503', async () => {
      const customer = seedCustomer(ctx.store);
      const product = seedProduct(ctx.store);
      const { ServiceUnavailableException } = await import('@nestjs/common');
      ctx.orchestrator.generatePreview.mockRejectedValue(
        new ServiceUnavailableException('Fitting Agent unavailable'),
      );

      await http()
        .post(`${API}/fitting/generate-preview`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          productId: product.id,
          customerPhotoUrl: 'https://cdn.codlock.tn/u/photo.jpg',
        })
        .expect(503);
    });
  });

  // ── Orders: the full lifecycle ───────────────────────────────

  describe('orders', () => {
    const createOrder = async (quantity = 2) => {
      const customer = seedCustomer(ctx.store);
      const product = seedProduct(ctx.store);
      const res = await http()
        .post(`${API}/orders`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          channel: 'INSTAGRAM',
          items: [
            { productId: product.id, size: 'M', color: 'black', quantity },
          ],
        })
        .expect(201);
      return { order: res.body.data, customer, product };
    };

    it('prices from the catalog and ignores any client-supplied price', async () => {
      const { order, customer, product } = await createOrder(2);

      // A client-supplied price is not an accepted field at all.
      await http()
        .post(`${API}/orders`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          channel: 'INSTAGRAM',
          items: [{ productId: product.id, quantity: 1, unitPrice: 1 }],
        })
        .expect(400);

      expect(order.total_price).toBe(159.8);
      expect(order.item_details[0]).toMatchObject({
        unitPrice: 79.9,
        title: 'Oversized Cotton Tee',
      });
      expect(order.status).toBe('DRAFT');
    });

    it('rejects a size the product does not carry', async () => {
      const customer = seedCustomer(ctx.store);
      const product = seedProduct(ctx.store);
      await http()
        .post(`${API}/orders`)
        .set('Authorization', auth)
        .send({
          customerId: customer.id,
          channel: 'INSTAGRAM',
          items: [{ productId: product.id, size: 'XXL', quantity: 1 }],
        })
        .expect(400);
    });

    it('runs the deposit-required path end to end', async () => {
      const { order, customer } = await createOrder(2);
      ctx.orchestrator.scoreRisk.mockResolvedValue({ score: 80 });
      ctx.orchestrator.createPaymentLink.mockResolvedValue({
        paymentId: 'pay_e2e_1',
        paymentUrl: 'https://pay.gravv.fi/l/e2e1',
      });

      const evaluated = await http()
        .post(`${API}/orders/${order.id}/evaluate-risk`)
        .set('Authorization', auth)
        .expect(201);
      expect(evaluated.body.data).toMatchObject({
        status: 'RISK_EVALUATED',
        risk_score: 80,
        deposit_rate: 0.2,
        deposit_amount: 31.96,
      });

      const pending = await http()
        .post(`${API}/orders/${order.id}/request-deposit`)
        .set('Authorization', auth)
        .expect(201);
      expect(pending.body.data).toMatchObject({
        status: 'DEPOSIT_PENDING',
        payment_id: 'pay_e2e_1',
      });
      expect(ctx.orchestrator.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: `deposit:${order.id}` }),
      );

      // Cannot ship before the provider confirms.
      await http()
        .post(`${API}/orders/${order.id}/ready-to-ship`)
        .set('Authorization', auth)
        .expect(400);

      const webhook = {
        eventId: 'evt_e2e_1',
        event: 'payment.succeeded',
        paymentId: 'pay_e2e_1',
        amount: 31.96,
        currency: 'TND',
      };
      const paid = await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(webhook, GRAVV_SECRET))
        .send(webhook)
        .expect(201);
      expect(paid.body.data).toMatchObject({
        applied: 'DEPOSIT_PAID',
        duplicate: false,
      });

      await http()
        .post(`${API}/orders/${order.id}/ready-to-ship`)
        .set('Authorization', auth)
        .expect(201);
      await http()
        .post(`${API}/orders/${order.id}/ship`)
        .set('Authorization', auth)
        .expect(201);

      const outcome = await http()
        .post(`${API}/orders/${order.id}/outcome`)
        .set('Authorization', auth)
        .send({ outcome: 'REFUSED' })
        .expect(201);
      expect(outcome.body.data.status).toBe('REFUSED');

      const stored = ctx.store.customers.find((c) => c.id === customer.id);
      expect(stored).toMatchObject({ total_orders: 1, refused_orders: 1 });
    });

    it('skips the charge entirely for a trusted buyer', async () => {
      const { order } = await createOrder(1);
      ctx.orchestrator.scoreRisk.mockResolvedValue({ score: 5 });

      await http()
        .post(`${API}/orders/${order.id}/evaluate-risk`)
        .set('Authorization', auth)
        .expect(201);

      const res = await http()
        .post(`${API}/orders/${order.id}/request-deposit`)
        .set('Authorization', auth)
        .expect(201);

      expect(res.body.data).toMatchObject({
        status: 'READY_TO_SHIP',
        deposit_status: 'PAID',
      });
      expect(ctx.orchestrator.createPaymentLink).not.toHaveBeenCalled();
    });

    it('refuses illegal lifecycle jumps with 409', async () => {
      const { order } = await createOrder(1);

      const res = await http()
        .post(`${API}/orders/${order.id}/ship`)
        .set('Authorization', auth)
        .expect(409);
      expect(res.body.error).toMatch(/DRAFT/);
    });

    it('resumes a deposit whose link was never persisted', async () => {
      const { order } = await createOrder(1);
      ctx.orchestrator.scoreRisk.mockResolvedValue({ score: 80 });
      await http()
        .post(`${API}/orders/${order.id}/evaluate-risk`)
        .set('Authorization', auth)
        .expect(201);

      ctx.orchestrator.createPaymentLink.mockRejectedValueOnce(
        new Error('provider timeout'),
      );
      await http()
        .post(`${API}/orders/${order.id}/request-deposit`)
        .set('Authorization', auth)
        .expect(500);

      const stranded = ctx.store.orders.find((o) => o.id === order.id);
      expect(stranded).toMatchObject({
        status: 'DEPOSIT_PENDING',
        deposit_status: 'FAILED',
        payment_id: null,
      });

      ctx.orchestrator.createPaymentLink.mockResolvedValue({
        paymentId: 'pay_retry',
        paymentUrl: 'https://pay.gravv.fi/l/retry',
      });
      const retried = await http()
        .post(`${API}/orders/${order.id}/request-deposit`)
        .set('Authorization', auth)
        .expect(201);

      expect(retried.body.data.payment_id).toBe('pay_retry');
      expect(ctx.orchestrator.createPaymentLink).toHaveBeenLastCalledWith(
        expect.objectContaining({ idempotencyKey: `deposit:${order.id}` }),
      );
    });

    it("404s on another seller's order", async () => {
      const { order } = await createOrder(1);
      const otherToken = `Bearer ${ctx.token(OTHER_SELLER_ID)}`;

      await http()
        .get(`${API}/orders/${order.id}`)
        .set('Authorization', otherToken)
        .expect(404);
      await http()
        .post(`${API}/orders/${order.id}/evaluate-risk`)
        .set('Authorization', otherToken)
        .expect(404);
    });

    it('cancels a DRAFT order', async () => {
      const { order } = await createOrder(1);
      const res = await http()
        .post(`${API}/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .expect(201);
      expect(res.body.data.status).toBe('CANCELLED');
    });

    it('cancels a deposit-pending order and expires the deposit', async () => {
      const { order } = await createOrder(1);
      ctx.orchestrator.scoreRisk.mockResolvedValue({ score: 80 });
      ctx.orchestrator.createPaymentLink.mockResolvedValue({
        paymentId: 'pay_c',
        paymentUrl: 'https://pay.gravv.fi/l/c',
      });
      await http()
        .post(`${API}/orders/${order.id}/evaluate-risk`)
        .set('Authorization', auth)
        .expect(201);
      await http()
        .post(`${API}/orders/${order.id}/request-deposit`)
        .set('Authorization', auth)
        .expect(201);

      const res = await http()
        .post(`${API}/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .expect(201);
      expect(res.body.data).toMatchObject({
        status: 'CANCELLED',
        deposit_status: 'EXPIRED',
      });
    });

    it('is idempotent when cancelling twice', async () => {
      const { order } = await createOrder(1);
      await http()
        .post(`${API}/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .expect(201);
      const res = await http()
        .post(`${API}/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .expect(201);
      expect(res.body.data.status).toBe('CANCELLED');
    });

    it('refuses to cancel a shipped order', async () => {
      const customer = seedCustomer(ctx.store);
      const shippedId = '99999999-9999-4999-8999-999999999999';
      (ctx.store.orders ??= []).push({
        id: shippedId,
        seller_id: SELLER_ID,
        customer_id: customer.id,
        status: 'SHIPPED',
        outcome: 'PENDING',
        total_price: 10,
        currency: 'TND',
        version: 0,
        created_at: '2026-02-01T00:00:00.000Z',
      });
      const res = await http()
        .post(`${API}/orders/${shippedId}/cancel`)
        .set('Authorization', auth)
        .expect(400);
      expect(res.body.error).toMatch(/cannot be cancelled/i);
    });

    it('paginates and sorts newest first', async () => {
      const customer = seedCustomer(ctx.store);
      for (let i = 0; i < 5; i++) {
        (ctx.store.orders ??= []).push({
          id: `o-${i}`,
          seller_id: SELLER_ID,
          customer_id: customer.id,
          status: 'DRAFT',
          outcome: 'PENDING',
          total_price: 10,
          currency: 'TND',
          version: 0,
          created_at: `2026-02-0${i + 1}T00:00:00.000Z`,
        });
      }

      const res = await http()
        .get(`${API}/orders?page=1&limit=2`)
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.data.total).toBe(5);
      expect(res.body.data.items.map((o: any) => o.id)).toEqual(['o-4', 'o-3']);
    });
  });

  // ── Payment webhook ──────────────────────────────────────────

  describe('gravv webhook', () => {
    const seedPendingOrder = () => {
      const customer = seedCustomer(ctx.store);
      (ctx.store.orders ??= []).push({
        id: '77777777-7777-4777-8777-777777777777',
        seller_id: SELLER_ID,
        customer_id: customer.id,
        status: 'DEPOSIT_PENDING',
        deposit_status: 'PENDING',
        deposit_amount: 29.8,
        total_price: 149,
        currency: 'TND',
        outcome: 'PENDING',
        payment_id: 'pay_hook',
        version: 1,
      });
    };

    const body = {
      eventId: 'evt_hook_1',
      event: 'payment.succeeded',
      paymentId: 'pay_hook',
      amount: 29.8,
      currency: 'TND',
    };

    it('is reachable without a JWT', async () => {
      seedPendingOrder();
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(body, GRAVV_SECRET))
        .send(body)
        .expect(201);
    });

    it('rejects a missing signature', async () => {
      seedPendingOrder();
      await http().post(`${API}/payments/gravv/webhook`).send(body).expect(401);
    });

    it('rejects a signature from the wrong secret', async () => {
      seedPendingOrder();
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(body, 'attacker-secret'))
        .send(body)
        .expect(401);
    });

    it('rejects a body altered after signing', async () => {
      seedPendingOrder();
      const signature = ctx.sign(body, GRAVV_SECRET);
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', signature)
        .send({ ...body, amount: 1 })
        .expect(401);
    });

    it('accepts a sha256= prefixed signature', async () => {
      seedPendingOrder();
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', `sha256=${ctx.sign(body, GRAVV_SECRET)}`)
        .send(body)
        .expect(201);
    });

    it('deduplicates a redelivered event', async () => {
      seedPendingOrder();
      const signature = ctx.sign(body, GRAVV_SECRET);

      const first = await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', signature)
        .send(body)
        .expect(201);
      expect(first.body.data.applied).toBe('DEPOSIT_PAID');

      const second = await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', signature)
        .send(body)
        .expect(201);
      expect(second.body.data).toMatchObject({
        applied: 'DUPLICATE',
        duplicate: true,
      });

      expect(
        ctx.store.orders.find((o) => o.payment_id === 'pay_hook')?.version,
      ).toBe(2);
    });

    it('refuses an amount that does not match the deposit', async () => {
      seedPendingOrder();
      const mismatched = { ...body, eventId: 'evt_bad', amount: 5 };
      const res = await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(mismatched, GRAVV_SECRET))
        .send(mismatched)
        .expect(400);
      expect(res.body.error).toMatch(/amount/i);
    });

    it('refuses a currency that does not match the order', async () => {
      seedPendingOrder();
      const mismatched = { ...body, eventId: 'evt_cur', currency: 'EUR' };
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(mismatched, GRAVV_SECRET))
        .send(mismatched)
        .expect(400);
    });

    it('rejects an unknown event type at the DTO boundary', async () => {
      seedPendingOrder();
      const bad = { ...body, event: 'payment.exploded' };
      await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(bad, GRAVV_SECRET))
        .send(bad)
        .expect(400);
    });

    it('marks a failed payment without paying the order', async () => {
      seedPendingOrder();
      const failed = {
        ...body,
        eventId: 'evt_failed',
        event: 'payment.failed',
      };
      const res = await http()
        .post(`${API}/payments/gravv/webhook`)
        .set('x-gravv-signature', ctx.sign(failed, GRAVV_SECRET))
        .send(failed)
        .expect(201);

      expect(res.body.data.applied).toBe('DEPOSIT_FAILED');
      expect(
        ctx.store.orders.find((o) => o.payment_id === 'pay_hook')?.status,
      ).toBe('DEPOSIT_PENDING');
    });
  });

  // ── Chat webhook ─────────────────────────────────────────────

  describe('chat order webhook', () => {
    let seq = 0;
    const chatBody = (overrides: Record<string, unknown> = {}) => ({
      eventId: `chat_evt_${seq++}`,
      sentAt: new Date().toISOString(),
      customerPhone: '+21620999888',
      customerName: 'Nadia',
      zone: 'Bizerte',
      sellerId: SELLER_ID,
      channel: 'WHATSAPP',
      items: [
        { productId: '55555555-5555-4555-8555-555555555555', quantity: 1 },
      ],
      ...overrides,
    });
    const post = (body: Record<string, unknown>) =>
      http()
        .post(`${API}/webhooks/chat/order`)
        .set('x-signature', ctx.sign(body, SOCIAL_SECRET))
        .send(body);

    it('creates a customer and a DRAFT order from a signed payload', async () => {
      seedProduct(ctx.store);
      const res = await post(chatBody()).expect(201);

      expect(res.body.data).toMatchObject({ status: 'DRAFT' });
      expect(ctx.store.customers).toHaveLength(1);
      expect(ctx.store.customers[0]).toMatchObject({
        phone: '+21620999888',
        seller_id: SELLER_ID,
      });
    });

    it('reuses an existing customer on the second message', async () => {
      seedProduct(ctx.store);
      seedCustomer(ctx.store, { phone: '+21620999888' });
      await post(chatBody()).expect(201);
      expect(ctx.store.customers).toHaveLength(1);
    });

    it('rejects an unsigned payload before validating it (401, no schema leak)', async () => {
      seedProduct(ctx.store);
      const res = await http()
        .post(`${API}/webhooks/chat/order`)
        .send({ garbage: true })
        .expect(401);
      // The guard runs before the pipe, so the DTO schema is never disclosed.
      expect(JSON.stringify(res.body)).not.toMatch(/customerPhone|items/);
      expect(ctx.store.orders ?? []).toHaveLength(0);
    });

    it('ignores a replayed event id without creating a second order', async () => {
      seedProduct(ctx.store);
      const body = chatBody();

      const first = await post(body).expect(201);
      expect(first.body.data).toMatchObject({ status: 'DRAFT' });

      const replay = await post(body).expect(201);
      expect(replay.body.data).toEqual({ duplicate: true });

      expect(ctx.store.orders).toHaveLength(1);
    });

    it('rejects a signed payload whose timestamp is stale', async () => {
      seedProduct(ctx.store);
      const stale = chatBody({
        sentAt: new Date(Date.now() - 3600_000).toISOString(),
      });
      await post(stale).expect(401);
      expect(ctx.store.orders ?? []).toHaveLength(0);
    });

    it('lets a genuine retry through after a failed creation', async () => {
      // No product seeded → buildCatalogItems throws (404). The event id must
      // be released so the same id can be retried once the product exists.
      const body = chatBody();
      await post(body).expect(404);

      seedProduct(ctx.store);
      const retry = await post(body).expect(201);
      expect(retry.body.data).toMatchObject({ status: 'DRAFT' });
    });

    it('rejects an invalid phone number', async () => {
      seedProduct(ctx.store);
      await post(chatBody({ customerPhone: '12345' })).expect(400);
    });

    it('404s when the product belongs to a different seller', async () => {
      seedProduct(ctx.store, { seller_id: OTHER_SELLER_ID });
      await post(chatBody()).expect(404);
    });
  });

  // ── Analytics ────────────────────────────────────────────────

  describe('analytics', () => {
    it('aggregates KPIs over settled orders only', async () => {
      const sfax = seedCustomer(ctx.store, { zone: 'Sfax' });
      const kairouan = seedCustomer(ctx.store, {
        id: '88888888-8888-4888-8888-888888888888',
        phone: '+21620111222',
        zone: 'Kairouan',
      });
      const order = (o: Record<string, any>) =>
        (ctx.store.orders ??= []).push({
          seller_id: SELLER_ID,
          currency: 'TND',
          version: 0,
          ...o,
        });

      order({
        id: 'a1',
        customer_id: sfax.id,
        outcome: 'ACCEPTED',
        total_price: 100,
      });
      order({
        id: 'a2',
        customer_id: sfax.id,
        outcome: 'ACCEPTED',
        total_price: 50.5,
      });
      order({
        id: 'r1',
        customer_id: kairouan.id,
        outcome: 'REFUSED',
        total_price: 80,
        deposit_amount: 16,
      });
      order({
        id: 'p1',
        customer_id: kairouan.id,
        outcome: 'PENDING',
        total_price: 90,
      });

      const res = await http()
        .get(`${API}/analytics/kpis`)
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.data).toMatchObject({
        sellerId: SELLER_ID,
        totalOrders: 4,
        acceptedOrders: 2,
        refusedOrders: 1,
        savedFromAcceptedOrders: 150.5,
        feesCoveredByDeposits: 16,
      });

      // Kairouan: 1 settled, 1 refused → 1.0, not 0.5 as an all-orders
      // denominator would give.
      expect(res.body.data.refusalByZone).toEqual([
        {
          zone: 'Kairouan',
          settledOrders: 1,
          refusedOrders: 1,
          refusalRate: 1,
        },
        { zone: 'Sfax', settledOrders: 2, refusedOrders: 0, refusalRate: 0 },
      ]);
    });

    it('returns zeroed KPIs for a seller with no orders', async () => {
      const res = await http()
        .get(`${API}/analytics/kpis`)
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.data).toMatchObject({
        totalOrders: 0,
        refusalByZone: [],
      });
    });
  });
});
