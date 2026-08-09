import { BadRequestException } from '@nestjs/common';
import { InvalidStateTransitionException } from '../../common/exceptions/invalid-state-transition.exception';
import {
  Channel,
  DepositStatus,
  OrderOutcome,
  OrderStatus,
} from '../../common/enums';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';

describe('OrdersService hardening', () => {
  const sellerId = '11111111-1111-4111-8111-111111111111';
  const otherSellerId = '22222222-2222-4222-8222-222222222222';
  const orderId = '33333333-3333-4333-8333-333333333333';
  const customerId = '44444444-4444-4444-8444-444444444444';
  const productId = '55555555-5555-4555-8555-555555555555';

  let builder: Record<string, jest.Mock>;
  let supabase: any;
  let customers: any;
  let products: any;
  let payments: any;
  let service: OrdersService;

  const order = (overrides: Partial<Order> = {}): Order => ({
    id: orderId,
    seller_id: sellerId,
    customer_id: customerId,
    channel: Channel.INSTAGRAM,
    item_details: [],
    status: OrderStatus.DRAFT,
    total_price: 149,
    currency: 'TND',
    risk_score: null,
    deposit_rate: null,
    deposit_amount: null,
    deposit_status: DepositStatus.NONE,
    payment_id: null,
    payment_url: null,
    outcome: OrderOutcome.PENDING,
    version: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    builder = {};
    for (const method of [
      'select',
      'eq',
      'order',
      'insert',
      'update',
      'single',
      'maybeSingle',
    ]) {
      builder[method] = jest.fn(() => builder);
    }
    supabase = {
      table: jest.fn(() => builder),
      unwrap: jest.fn((result) => result.data),
      client: { rpc: jest.fn() },
    };
    customers = {
      findOneForSeller: jest.fn(),
      upsertByPhone: jest.fn(),
    };
    products = { findManyForSeller: jest.fn() };
    payments = { createDepositLink: jest.fn() };
    service = new OrdersService(
      supabase,
      { logEvent: jest.fn() } as any,
      customers,
      products,
      { evaluate: jest.fn() } as any,
      payments,
      { get: jest.fn(() => 300) } as any,
    );
  });

  it('scopes a single-order lookup to the authenticated seller', async () => {
    builder.maybeSingle.mockResolvedValue({ data: order(), error: null });

    await service.findOneForSeller(otherSellerId, orderId);

    expect(builder.eq).toHaveBeenCalledWith('id', orderId);
    expect(builder.eq).toHaveBeenCalledWith('seller_id', otherSellerId);
  });

  it('builds order snapshots from catalog prices, not request prices', async () => {
    customers.findOneForSeller.mockResolvedValue({ id: customerId });
    products.findManyForSeller.mockResolvedValue([
      {
        id: productId,
        seller_id: sellerId,
        title: 'Catalog dress',
        price: 149,
        sizes: ['M'],
        colors: ['beige'],
      },
    ]);
    const created = order();
    const insertDraft = jest
      .spyOn(service as any, 'insertDraft')
      .mockResolvedValue(created);

    await service.create(sellerId, {
      customerId,
      channel: Channel.INSTAGRAM,
      items: [{ productId, size: 'M', color: 'beige', quantity: 2 }],
    });

    expect(insertDraft).toHaveBeenCalledWith(
      sellerId,
      customerId,
      Channel.INSTAGRAM,
      [
        expect.objectContaining({
          productId,
          title: 'Catalog dress',
          unitPrice: 149,
          quantity: 2,
        }),
      ],
    );
  });

  it('does not allow a risk-evaluated order to skip directly to shipping', async () => {
    jest
      .spyOn(service, 'findOneForSeller')
      .mockResolvedValue(order({ status: OrderStatus.RISK_EVALUATED }));

    await expect(service.markShipped(sellerId, orderId)).rejects.toBeInstanceOf(
      InvalidStateTransitionException,
    );
  });

  it('uses a stable payment idempotency key', async () => {
    const evaluated = order({
      status: OrderStatus.RISK_EVALUATED,
      deposit_amount: 29.8,
      deposit_rate: 0.2,
    });
    const reserved = order({
      status: OrderStatus.DEPOSIT_PENDING,
      deposit_status: DepositStatus.PENDING,
      deposit_amount: 29.8,
      version: 1,
    });
    jest.spyOn(service, 'findOneForSeller').mockResolvedValue(evaluated);
    jest
      .spyOn(service as any, 'persistTransition')
      .mockResolvedValueOnce(reserved)
      .mockResolvedValueOnce(
        order({ status: OrderStatus.DEPOSIT_PENDING, payment_id: 'pay_1' }),
      );
    payments.createDepositLink.mockResolvedValue({
      paymentId: 'pay_1',
      paymentUrl: 'https://payments.example/pay_1',
    });

    await service.requestDeposit(sellerId, orderId);

    expect(payments.createDepositLink).toHaveBeenCalledWith(
      reserved,
      `deposit:${orderId}`,
    );
  });

  describe('resuming a deposit request', () => {
    const pending = (overrides: Partial<Order> = {}) =>
      order({
        status: OrderStatus.DEPOSIT_PENDING,
        deposit_amount: 29.8,
        deposit_rate: 0.2,
        version: 1,
        ...overrides,
      });

    it('returns the existing link when one was already persisted', async () => {
      const linked = pending({ payment_id: 'pay_1' });
      jest.spyOn(service, 'findOneForSeller').mockResolvedValue(linked);

      await expect(service.requestDeposit(sellerId, orderId)).resolves.toBe(
        linked,
      );
      expect(payments.createDepositLink).not.toHaveBeenCalled();
    });

    // Regression: a DEPOSIT_PENDING order whose payment_id was never written
    // (provider call failed, or the follow-up update lost a version race) used
    // to be rejected as "not eligible" forever, stranding a live payment that
    // no webhook could match.
    it.each([
      DepositStatus.PENDING,
      DepositStatus.FAILED,
      DepositStatus.EXPIRED,
    ])(
      'retries when deposit_status is %s and no link was stored',
      async (depositStatus) => {
        const stranded = pending({ deposit_status: depositStatus });
        jest.spyOn(service, 'findOneForSeller').mockResolvedValue(stranded);
        jest
          .spyOn(service as any, 'persistTransition')
          .mockResolvedValueOnce(stranded)
          .mockResolvedValueOnce(pending({ payment_id: 'pay_1' }));
        payments.createDepositLink.mockResolvedValue({
          paymentId: 'pay_1',
          paymentUrl: 'https://payments.example/pay_1',
        });

        await service.requestDeposit(sellerId, orderId);

        // Same key as the first attempt, so the provider returns the original
        // payment rather than charging the customer twice.
        expect(payments.createDepositLink).toHaveBeenCalledWith(
          stranded,
          `deposit:${orderId}`,
        );
      },
    );

    it('does not re-request a deposit that is already paid', async () => {
      jest
        .spyOn(service, 'findOneForSeller')
        .mockResolvedValue(pending({ deposit_status: DepositStatus.PAID }));

      await expect(
        service.requestDeposit(sellerId, orderId),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(payments.createDepositLink).not.toHaveBeenCalled();
    });

    it('rejects a pending order that carries no deposit amount', async () => {
      jest
        .spyOn(service, 'findOneForSeller')
        .mockResolvedValue(pending({ deposit_amount: null }));

      await expect(
        service.requestDeposit(sellerId, orderId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still refuses statuses that never priced a deposit', async () => {
      jest
        .spyOn(service, 'findOneForSeller')
        .mockResolvedValue(order({ status: OrderStatus.DRAFT }));

      await expect(
        service.requestDeposit(sellerId, orderId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the charge entirely for a trusted buyer', async () => {
      const evaluated = order({
        status: OrderStatus.RISK_EVALUATED,
        deposit_amount: 0,
        deposit_rate: 0,
      });
      jest.spyOn(service, 'findOneForSeller').mockResolvedValue(evaluated);
      const persist = jest
        .spyOn(service as any, 'persistTransition')
        .mockResolvedValue(order({ status: OrderStatus.READY_TO_SHIP }));

      await service.requestDeposit(sellerId, orderId);

      expect(persist).toHaveBeenCalledWith(
        evaluated,
        OrderStatus.READY_TO_SHIP,
        { deposit_status: DepositStatus.PAID },
      );
      expect(payments.createDepositLink).not.toHaveBeenCalled();
    });
  });

  it('treats a repeated final outcome as an idempotent replay', async () => {
    const accepted = order({
      status: OrderStatus.ACCEPTED,
      outcome: OrderOutcome.ACCEPTED,
    });
    jest.spyOn(service, 'findOneForSeller').mockResolvedValue(accepted);

    await expect(
      service.recordOutcome(sellerId, orderId, OrderOutcome.ACCEPTED),
    ).resolves.toBe(accepted);
    expect(supabase.client.rpc).not.toHaveBeenCalled();
  });

  describe('cancel', () => {
    it.each([
      OrderStatus.DRAFT,
      OrderStatus.PREVIEW_GENERATED,
      OrderStatus.RISK_EVALUATED,
      OrderStatus.DEPOSIT_PENDING,
    ])('cancels a %s order', async (status) => {
      jest
        .spyOn(service, 'findOneForSeller')
        .mockResolvedValue(order({ status }));
      const persist = jest
        .spyOn(service as any, 'persistTransition')
        .mockResolvedValue(order({ status: OrderStatus.CANCELLED }));

      await service.cancel(sellerId, orderId);
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        OrderStatus.CANCELLED,
        expect.any(Object),
      );
    });

    it('expires a pending deposit on cancellation', async () => {
      jest.spyOn(service, 'findOneForSeller').mockResolvedValue(
        order({
          status: OrderStatus.DEPOSIT_PENDING,
          deposit_status: DepositStatus.PENDING,
        }),
      );
      const persist = jest
        .spyOn(service as any, 'persistTransition')
        .mockResolvedValue(order({ status: OrderStatus.CANCELLED }));

      await service.cancel(sellerId, orderId);
      expect(persist).toHaveBeenCalledWith(
        expect.anything(),
        OrderStatus.CANCELLED,
        {
          deposit_status: DepositStatus.EXPIRED,
        },
      );
    });

    it.each([
      OrderStatus.DEPOSIT_PAID,
      OrderStatus.READY_TO_SHIP,
      OrderStatus.SHIPPED,
      OrderStatus.ACCEPTED,
    ])('refuses to cancel a %s order', async (status) => {
      jest
        .spyOn(service, 'findOneForSeller')
        .mockResolvedValue(order({ status }));
      await expect(service.cancel(sellerId, orderId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('is an idempotent no-op when already cancelled', async () => {
      const cancelled = order({ status: OrderStatus.CANCELLED });
      jest.spyOn(service, 'findOneForSeller').mockResolvedValue(cancelled);
      const persist = jest.spyOn(service as any, 'persistTransition');

      await expect(service.cancel(sellerId, orderId)).resolves.toBe(cancelled);
      expect(persist).not.toHaveBeenCalled();
    });
  });
});
