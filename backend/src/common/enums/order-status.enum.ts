/**
 * Canonical order lifecycle. Transitions are enforced in OrdersService.
 *
 * DRAFT → PREVIEW_GENERATED → RISK_EVALUATED → DEPOSIT_PENDING
 *       → DEPOSIT_PAID → SHIPPED → ACCEPTED | REFUSED
 */
export enum OrderStatus {
  DRAFT = 'DRAFT',
  PREVIEW_GENERATED = 'PREVIEW_GENERATED',
  RISK_EVALUATED = 'RISK_EVALUATED',
  DEPOSIT_PENDING = 'DEPOSIT_PENDING',
  DEPOSIT_PAID = 'DEPOSIT_PAID',
  READY_TO_SHIP = 'READY_TO_SHIP',
  SHIPPED = 'SHIPPED',
  ACCEPTED = 'ACCEPTED',
  REFUSED = 'REFUSED',
  /** Terminal: abandoned before fulfilment (seller-cancelled). */
  CANCELLED = 'CANCELLED',
}

/**
 * Allowed forward transitions. Any move not listed here is rejected as an
 * invalid state transition (HTTP 409).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [
    OrderStatus.PREVIEW_GENERATED,
    OrderStatus.RISK_EVALUATED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PREVIEW_GENERATED]: [
    OrderStatus.RISK_EVALUATED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.RISK_EVALUATED]: [
    OrderStatus.DEPOSIT_PENDING,
    OrderStatus.READY_TO_SHIP,
    OrderStatus.CANCELLED,
  ],
  // A deposit awaiting payment can be abandoned; once paid or in fulfilment it
  // can no longer be cancelled through this path.
  [OrderStatus.DEPOSIT_PENDING]: [
    OrderStatus.DEPOSIT_PAID,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.DEPOSIT_PAID]: [OrderStatus.READY_TO_SHIP],
  [OrderStatus.READY_TO_SHIP]: [OrderStatus.SHIPPED],
  [OrderStatus.SHIPPED]: [OrderStatus.ACCEPTED, OrderStatus.REFUSED],
  [OrderStatus.ACCEPTED]: [],
  [OrderStatus.REFUSED]: [],
  [OrderStatus.CANCELLED]: [],
};
