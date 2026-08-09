/**
 * The contract between the orchestrator and the Payment Agent.
 *
 * Single source of truth for every payload crossing the agent boundary. Mirrors
 * `fitting-agent/src/codlock_agents/schemas.py` on the Python side — if you change a
 * shape here, change it there.
 *
 * Money is always a decimal **string**, never a JSON number. TND has three decimal
 * places (millimes) and IEEE floats lose them.
 */

import { z } from 'zod';

/** A decimal amount as a string: "29.800", not 29.8. */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string, e.g. "29.800"');

export const MoneySchema = z.object({
  amount: decimalString,
  /** What the customer sees. TND for a Tunisian order. */
  currency: z.string().length(3).default('TND'),
});
export type Money = z.infer<typeof MoneySchema>;

export const ChannelSchema = z.enum(['instagram', 'whatsapp']);

export const CustomerRefSchema = z.object({
  customer_id: z.string(),
  full_name: z.string(),
  /** E.164 preferred, e.g. "+21620123456". */
  phone: z.string(),
  email: z.string().nullish(),
  /** Delivery zone. Carried for audit; the risk decision is made upstream. */
  zone: z.string().nullish(),
});

/** Gravv-side identifiers, so the backend can reconcile without guessing. */
export const GravvRefsSchema = z.object({
  seller_account_id: z.string().nullish(),
  seller_customer_id: z.string().nullish(),
  collection_id: z.string().nullish(),
  payment_link_id: z.string().nullish(),
  /**
   * What Gravv actually moves, when it differs from the displayed currency.
   * Gravv holds value in stablecoin and quotes card collections in USD, while
   * orders are priced in TND. Null when the two match.
   */
  settlement: MoneySchema.nullish(),
  environment: z.enum(['sandbox', 'live']).nullish(),
});
export type GravvRefs = z.infer<typeof GravvRefsSchema>;

export const DepositStatusSchema = z.enum([
  /** Risk scoring returned a zero deposit. Gravv was never called. */
  'not_required',
  /** A checkout exists and the customer has not paid yet. */
  'awaiting_payment',
  'paid',
  'expired',
  'failed',
]);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;

// ---------------------------------------------------------------------------------
// skill: collect_deposit
// ---------------------------------------------------------------------------------

/**
 * "Risk said N, go make it payable."
 *
 * The Payment Agent does **not** decide the amount. `deposit` arrives already decided
 * by the orchestrator's risk-scoring tool; `risk_score` and `deposit_rate` are carried
 * only so the payment record explains itself later.
 */
export const CollectDepositInputSchema = z.object({
  /** Idempotency anchor. Two calls with the same order_id must not open two checkouts. */
  order_id: z.string(),
  seller_id: z.string(),
  customer: CustomerRefSchema,
  order_total: MoneySchema,
  /** Zero is legal and means "no deposit required". */
  deposit: MoneySchema,
  /** 0.20 for 20%. Audit only. */
  deposit_rate: z.number().min(0).max(1),
  /** Audit only. */
  risk_score: z.number().int().min(0).max(100),
  channel: ChannelSchema,
});
export type CollectDepositInput = z.infer<typeof CollectDepositInputSchema>;

export const CollectDepositOutputSchema = z.object({
  payment_id: z.string(),
  order_id: z.string(),
  status: DepositStatusSchema,
  amount: MoneySchema,
  /** The one-tap link the customer opens. Null when not_required or failed. */
  checkout_url: z.string().nullable(),
  expires_at: z.string().nullable(),
  gravv: GravvRefsSchema,
  failure_reason: z.string().nullable(),
});
export type CollectDepositOutput = z.infer<typeof CollectDepositOutputSchema>;

// ---------------------------------------------------------------------------------
// skill: confirm_payment
// ---------------------------------------------------------------------------------

export const ConfirmPaymentInputSchema = z.object({
  payment_id: z.string(),
  order_id: z.string(),
});
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentInputSchema>;

export const ConfirmPaymentOutputSchema = z.object({
  payment_id: z.string(),
  order_id: z.string(),
  status: DepositStatusSchema,
  paid: MoneySchema.nullable(),
  paid_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
});
export type ConfirmPaymentOutput = z.infer<typeof ConfirmPaymentOutputSchema>;

// ---------------------------------------------------------------------------------
// skill: settle_order
// ---------------------------------------------------------------------------------

export const OrderOutcomeSchema = z.enum(['accepted', 'refused']);
export type OrderOutcome = z.infer<typeof OrderOutcomeSchema>;

export const DispositionSchema = z.enum([
  /** Accepted: the deposit comes off what the customer still owes the courier. */
  'applied_to_total',
  /** Refused: the deposit covers the round trip instead of the seller eating it. */
  'retained_for_courier',
  /** No deposit was ever taken, or it was never actually paid. */
  'nothing_to_settle',
]);
export type Disposition = z.infer<typeof DispositionSchema>;

export const SettleOrderInputSchema = z.object({
  order_id: z.string(),
  payment_id: z.string(),
  outcome: OrderOutcomeSchema,
  /** Required when refused, to compute whether the deposit covered the round trip. */
  courier_fee: MoneySchema.nullish(),
});
export type SettleOrderInput = z.infer<typeof SettleOrderInputSchema>;

export const SettleOrderOutputSchema = z.object({
  order_id: z.string(),
  payment_id: z.string(),
  disposition: DispositionSchema,
  deposit_amount: MoneySchema,
  /** Accepted: what the customer still pays on delivery. */
  remaining_due: MoneySchema.nullable(),
  /** Refused: how much of the courier fee the deposit ate. */
  courier_covered: MoneySchema.nullable(),
  /** Refused: what the seller still loses. Zero is the win case. */
  seller_shortfall: MoneySchema.nullable(),
});
export type SettleOrderOutput = z.infer<typeof SettleOrderOutputSchema>;

/** Every skill this agent answers, with the schema its input must satisfy. */
export const SKILL_INPUTS = {
  collect_deposit: CollectDepositInputSchema,
  confirm_payment: ConfirmPaymentInputSchema,
  settle_order: SettleOrderInputSchema,
} as const;

export type SkillName = keyof typeof SKILL_INPUTS;

export const SKILL_NAMES = Object.keys(SKILL_INPUTS) as SkillName[];
