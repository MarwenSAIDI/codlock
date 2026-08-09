/**
 * Payment Agent logic: deposit lifecycle.
 *
 * Deliberately free of LLM reasoning. Money movement is a fixed sequence of calls with
 * a fixed set of outcomes; an agent improvising over payment tools is what breaks on
 * stage. The intelligence in CODLOCK lives in risk scoring (upstream) and the fitting
 * room (the other agent).
 */

import Decimal from 'decimal.js';

import type {
  CollectDepositInput,
  CollectDepositOutput,
  ConfirmPaymentInput,
  ConfirmPaymentOutput,
  DepositStatus,
  GravvRefs,
  Money,
  SettleOrderInput,
  SettleOrderOutput,
} from './schemas.js';
import { settle } from './settlement.js';

const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What the agent remembers about one deposit.
 *
 * In memory on purpose for now: the durable copy belongs in the backend's Supabase
 * `orders` table, which the backend owner owns. Restarting the agent mid-demo loses
 * these — a known and accepted limitation.
 */
export interface PaymentRecord {
  paymentId: string;
  orderId: string;
  sellerId: string;
  customerId: string;
  orderTotal: Money;
  deposit: Money;
  status: DepositStatus;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  gravv: GravvRefs;
  paidAt: Date | null;
  pollCount: number;
}

export class PaymentStore {
  private byPayment = new Map<string, PaymentRecord>();
  private byOrder = new Map<string, string>();

  put(record: PaymentRecord): void {
    this.byPayment.set(record.paymentId, record);
    this.byOrder.set(record.orderId, record.paymentId);
  }

  byPaymentId(paymentId: string): PaymentRecord | undefined {
    return this.byPayment.get(paymentId);
  }

  byOrderId(orderId: string): PaymentRecord | undefined {
    const paymentId = this.byOrder.get(orderId);
    return paymentId ? this.byPayment.get(paymentId) : undefined;
  }
}

/** What a payment backend hands back once a deposit is payable. */
export interface Checkout {
  checkoutUrl: string;
  refs: GravvRefs;
}

export interface PaymentBackend {
  openCheckout(request: CollectDepositInput): Promise<Checkout>;
  pollStatus(record: PaymentRecord): Promise<DepositStatus>;
}

/**
 * Answers from fixtures. No network, no credentials, no Gravv.
 *
 * `pollStatus` reports awaiting_payment once and paid from the second poll onward, so
 * the orchestrator is forced to write real polling rather than assuming an instant
 * success it will not get in production.
 */
export class StubBackend implements PaymentBackend {
  async openCheckout(request: CollectDepositInput): Promise<Checkout> {
    const token = randomToken();
    return {
      checkoutUrl: `https://checkout.sandbox.gravv.xyz/stub/${token}`,
      refs: {
        seller_account_id: `acc_stub_${request.seller_id}`,
        seller_customer_id: `cus_stub_${request.seller_id}`,
        collection_id: `pi_stub_${token}`,
        payment_link_id: null,
        settlement: null,
        environment: 'sandbox',
      },
    };
  }

  async pollStatus(record: PaymentRecord): Promise<DepositStatus> {
    if (record.expiresAt && Date.now() > record.expiresAt.getTime()) return 'expired';
    return record.pollCount <= 1 ? 'awaiting_payment' : 'paid';
  }
}

export class PaymentService {
  constructor(
    private readonly backend: PaymentBackend,
    private readonly store: PaymentStore = new PaymentStore(),
  ) {}

  async collectDeposit(request: CollectDepositInput): Promise<CollectDepositOutput> {
    // order_id is the idempotency anchor: never open a second checkout.
    const existing = this.store.byOrderId(request.order_id);
    if (existing) return toCollectOutput(existing);

    const common = {
      paymentId: `pay_${randomToken()}`,
      orderId: request.order_id,
      sellerId: request.seller_id,
      customerId: request.customer.customer_id,
      orderTotal: request.order_total,
      deposit: request.deposit,
      paidAt: null,
      pollCount: 0,
    };

    if (new Decimal(request.deposit.amount).isZero()) {
      const record: PaymentRecord = {
        ...common,
        status: 'not_required',
        checkoutUrl: null,
        expiresAt: null,
        gravv: emptyRefs(),
      };
      this.store.put(record);
      return toCollectOutput(record);
    }

    const checkout = await this.backend.openCheckout(request);
    const record: PaymentRecord = {
      ...common,
      status: 'awaiting_payment',
      checkoutUrl: checkout.checkoutUrl,
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
      gravv: checkout.refs,
    };
    this.store.put(record);
    return toCollectOutput(record);
  }

  async confirmPayment(request: ConfirmPaymentInput): Promise<ConfirmPaymentOutput> {
    const record =
      this.store.byPaymentId(request.payment_id) ??
      this.store.byOrderId(request.order_id);

    if (!record) {
      return {
        payment_id: request.payment_id,
        order_id: request.order_id,
        status: 'failed',
        paid: null,
        paid_at: null,
        failure_reason: `No payment ${request.payment_id} for order ${request.order_id}.`,
      };
    }

    if (record.status === 'not_required' || record.status === 'paid') {
      return toConfirmOutput(record);
    }

    record.pollCount += 1;
    record.status = await this.backend.pollStatus(record);
    if (record.status === 'paid' && record.paidAt === null) record.paidAt = new Date();
    this.store.put(record);
    return toConfirmOutput(record);
  }

  async settleOrder(request: SettleOrderInput): Promise<SettleOrderOutput> {
    const record =
      this.store.byPaymentId(request.payment_id) ??
      this.store.byOrderId(request.order_id);

    if (!record) {
      throw new LookupError(
        `No payment ${request.payment_id} for order ${request.order_id}. ` +
          'settle_order must follow a collect_deposit.',
      );
    }

    return settle({
      orderId: record.orderId,
      paymentId: record.paymentId,
      orderTotal: record.orderTotal,
      deposit: record.deposit,
      depositPaid: record.status === 'paid',
      outcome: request.outcome,
      courierFee: request.courier_fee ?? null,
    });
  }
}

export class LookupError extends Error {
  override readonly name = 'LookupError';
}

function emptyRefs(): GravvRefs {
  return {
    seller_account_id: null,
    seller_customer_id: null,
    collection_id: null,
    payment_link_id: null,
    settlement: null,
    environment: null,
  };
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function toCollectOutput(record: PaymentRecord): CollectDepositOutput {
  return {
    payment_id: record.paymentId,
    order_id: record.orderId,
    status: record.status,
    amount: record.deposit,
    checkout_url: record.checkoutUrl,
    expires_at: record.expiresAt ? record.expiresAt.toISOString() : null,
    gravv: record.gravv,
    failure_reason: null,
  };
}

function toConfirmOutput(record: PaymentRecord): ConfirmPaymentOutput {
  return {
    payment_id: record.paymentId,
    order_id: record.orderId,
    status: record.status,
    paid: record.status === 'paid' ? record.deposit : null,
    paid_at: record.paidAt ? record.paidAt.toISOString() : null,
    failure_reason: null,
  };
}
