import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../enums';

/** Thrown when an order is asked to move to a state it cannot legally reach. */
export class InvalidStateTransitionException extends ConflictException {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Invalid order transition: ${from} → ${to}`);
  }
}
