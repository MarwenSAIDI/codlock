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
  SHIPPED = 'SHIPPED',
  ACCEPTED = 'ACCEPTED',
  REFUSED = 'REFUSED',
}

/**
 * Allowed forward transitions. Any move not listed here is rejected as an
 * invalid state transition (HTTP 409).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [OrderStatus.PREVIEW_GENERATED, OrderStatus.RISK_EVALUATED],
  [OrderStatus.PREVIEW_GENERATED]: [OrderStatus.RISK_EVALUATED],
  [OrderStatus.RISK_EVALUATED]: [OrderStatus.DEPOSIT_PENDING, OrderStatus.SHIPPED],
  [OrderStatus.DEPOSIT_PENDING]: [OrderStatus.DEPOSIT_PAID, OrderStatus.REFUSED],
  [OrderStatus.DEPOSIT_PAID]: [OrderStatus.SHIPPED],
  [OrderStatus.SHIPPED]: [OrderStatus.ACCEPTED, OrderStatus.REFUSED],
  [OrderStatus.ACCEPTED]: [],
  [OrderStatus.REFUSED]: [],
};
