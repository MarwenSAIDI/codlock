/** Deposit payment state, mirrored from Gravv webhook events. */
export enum DepositStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

/** Final delivery outcome once the parcel reaches the customer. */
export enum OrderOutcome {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REFUSED = 'REFUSED',
}

/** Normalised Gravv webhook event types we react to. */
export enum GravvEventType {
  PAYMENT_SUCCEEDED = 'payment.succeeded',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_EXPIRED = 'payment.expired',
}
