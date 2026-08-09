/**
 * Request/response contracts for calls into the Codlock Orchestrator Agent.
 * These mirror the A2A tool signatures exposed by the orchestrator; keep them
 * in sync with the agent side. They are internal transport types, not HTTP
 * DTOs — client-facing validation lives in each feature module's `dto/`.
 */
import { Channel } from '../../../common/enums';

// ── Fitting Agent ────────────────────────────────────────────
export interface GeneratePreviewRequest {
  orderId?: string;
  customerId: string;
  productId: string;
  customerPhotoUrl: string;
  size?: string;
  color?: string;
}

export interface GeneratePreviewResponse {
  previewPhotoUrl: string;
  originalPhotoUrl: string;
  model?: string;
  latencyMs?: number;
}

// ── Risk Scoring Tool ────────────────────────────────────────
export interface RiskScoreRequest {
  customerId: string;
  phone?: string;
  zone?: string;
  channel?: Channel;
  orderValue?: number;
}

export interface RiskScoreResponse {
  /** 0 (safe) – 100 (high risk). */
  score: number;
  factors?: {
    refusalHistoryRate?: number;
    completedOrders?: number;
    zoneRefusalRate?: number;
    firstTimeBuyer?: boolean;
  };
}

// ── Payment Agent → gravvfi/mcp ──────────────────────────────
export interface CreatePaymentLinkRequest {
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentLinkResponse {
  paymentId: string;
  /**
   * The one-tap checkout link. Null when the Payment Agent answered
   * `not_required` — a zero deposit is a legal outcome and never touches Gravv,
   * so there is no link to open. `orders.payment_url` is nullable to match.
   */
  paymentUrl: string | null;
  expiresAt?: string | null;
  status?: string;
}
