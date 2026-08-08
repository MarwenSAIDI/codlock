/**
 * Settlement arithmetic — the part that expresses CODLOCK's actual claim.
 *
 * Pure and dependency-free on purpose: no Gravv, no store, no clock. If these numbers
 * are wrong the pitch is wrong, so they are tested directly.
 */

import Decimal from 'decimal.js';

import type {
  Disposition,
  Money,
  OrderOutcome,
  SettleOrderOutput,
} from './schemas.js';

/** TND is a three-decimal currency: 1 dinar = 1000 millimes. */
const SCALE = 3;

export function money(amount: Decimal | string, currency: string): Money {
  return { amount: new Decimal(amount).toFixed(SCALE), currency };
}

export interface SettleArgs {
  orderId: string;
  paymentId: string;
  orderTotal: Money;
  deposit: Money;
  /** A checkout that was opened but never paid must settle as if it were zero. */
  depositPaid: boolean;
  outcome: OrderOutcome;
  courierFee?: Money | null;
}

export function settle(args: SettleArgs): SettleOrderOutput {
  const { orderId, paymentId, orderTotal, deposit, depositPaid, outcome } = args;
  const currency = orderTotal.currency;
  const total = new Decimal(orderTotal.amount);
  const held = depositPaid ? new Decimal(deposit.amount) : new Decimal(0);
  const fee = args.courierFee ? new Decimal(args.courierFee.amount) : new Decimal(0);

  const base = {
    order_id: orderId,
    payment_id: paymentId,
    remaining_due: null,
    courier_covered: null,
    seller_shortfall: null,
  };

  // No money was ever actually held. This is the status quo CODLOCK removes, and
  // reporting it honestly matters more than making the demo look tidy.
  if (held.isZero()) {
    return {
      ...base,
      disposition: 'nothing_to_settle' satisfies Disposition,
      deposit_amount: money('0', currency),
      remaining_due: outcome === 'accepted' ? money(total, currency) : null,
      seller_shortfall:
        outcome === 'refused' && args.courierFee
          ? money(fee, args.courierFee.currency)
          : null,
    };
  }

  if (outcome === 'accepted') {
    return {
      ...base,
      disposition: 'applied_to_total' satisfies Disposition,
      deposit_amount: money(held, currency),
      remaining_due: money(Decimal.max(0, total.minus(held)), currency),
    };
  }

  return {
    ...base,
    disposition: 'retained_for_courier' satisfies Disposition,
    deposit_amount: money(held, currency),
    courier_covered: money(Decimal.min(held, fee), currency),
    seller_shortfall: money(Decimal.max(0, fee.minus(held)), currency),
  };
}
