/**
 * Settlement arithmetic — the part that expresses CODLOCK's actual claim.
 * If these numbers are wrong the pitch is wrong.
 */

import { describe, expect, it } from 'vitest';

import type { Money, OrderOutcome } from '../src/schemas.js';
import { settle } from '../src/settlement.js';

const tnd = (amount: string): Money => ({ amount, currency: 'TND' });

const run = (args: {
  orderTotal: string;
  deposit: string;
  depositPaid: boolean;
  outcome: OrderOutcome;
  courierFee?: string;
}) =>
  settle({
    orderId: 'ord_1',
    paymentId: 'pay_1',
    orderTotal: tnd(args.orderTotal),
    deposit: tnd(args.deposit),
    depositPaid: args.depositPaid,
    outcome: args.outcome,
    courierFee: args.courierFee ? tnd(args.courierFee) : null,
  });

describe('settlement', () => {
  it('applies the deposit to the total when the order is accepted', () => {
    const result = run({
      orderTotal: '149.000', deposit: '29.800', depositPaid: true, outcome: 'accepted',
    });
    expect(result.disposition).toBe('applied_to_total');
    expect(result.remaining_due?.amount).toBe('119.200');
    expect(result.seller_shortfall).toBeNull();
  });

  it('retains the deposit against the courier round trip when refused', () => {
    const result = run({
      orderTotal: '149.000', deposit: '29.800', depositPaid: true,
      outcome: 'refused', courierFee: '8.000',
    });
    expect(result.disposition).toBe('retained_for_courier');
    expect(result.courier_covered?.amount).toBe('8.000');
    // The whole point: the seller loses nothing on a refusal.
    expect(result.seller_shortfall?.amount).toBe('0.000');
  });

  it('reports the gap when the deposit is smaller than the courier fee', () => {
    const result = run({
      orderTotal: '40.000', deposit: '5.000', depositPaid: true,
      outcome: 'refused', courierFee: '8.000',
    });
    expect(result.courier_covered?.amount).toBe('5.000');
    expect(result.seller_shortfall?.amount).toBe('3.000');
  });

  it('leaves the seller fully exposed when no deposit was taken', () => {
    // The status quo CODLOCK removes — reported honestly, not hidden.
    const result = run({
      orderTotal: '149.000', deposit: '0', depositPaid: false,
      outcome: 'refused', courierFee: '8.000',
    });
    expect(result.disposition).toBe('nothing_to_settle');
    expect(result.seller_shortfall?.amount).toBe('8.000');
  });

  it('treats an unpaid deposit as no deposit', () => {
    // An abandoned checkout must not settle as if money had arrived.
    const result = run({
      orderTotal: '149.000', deposit: '29.800', depositPaid: false,
      outcome: 'refused', courierFee: '8.000',
    });
    expect(result.disposition).toBe('nothing_to_settle');
    expect(result.seller_shortfall?.amount).toBe('8.000');
  });

  it('never produces a negative balance', () => {
    const result = run({
      orderTotal: '20.000', deposit: '25.000', depositPaid: true, outcome: 'accepted',
    });
    expect(result.remaining_due?.amount).toBe('0.000');
  });

  it('keeps millimes intact', () => {
    // TND has three decimal places. Float arithmetic loses them; Decimal does not.
    const result = run({
      orderTotal: '149.999', deposit: '29.999', depositPaid: true, outcome: 'accepted',
    });
    expect(result.remaining_due?.amount).toBe('120.000');
  });

  it('survives the float trap that motivated Decimal', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754.
    const result = run({
      orderTotal: '0.300', deposit: '0.100', depositPaid: true, outcome: 'accepted',
    });
    expect(result.remaining_due?.amount).toBe('0.200');
  });
});
