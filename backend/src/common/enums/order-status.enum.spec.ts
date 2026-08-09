import { ORDER_TRANSITIONS, OrderStatus } from './order-status.enum';

const ALL_STATUSES = Object.values(OrderStatus);

/**
 * The transition table is the business rule that stops an order from being
 * shipped before its deposit clears, so it is asserted directly rather than
 * only through OrdersService.
 */
describe('ORDER_TRANSITIONS', () => {
  it('covers every status exactly once', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  it('only ever points at real statuses', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATUSES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  describe('the money-critical edges', () => {
    it.each([
      [OrderStatus.DRAFT, OrderStatus.PREVIEW_GENERATED],
      [OrderStatus.DRAFT, OrderStatus.RISK_EVALUATED],
      [OrderStatus.PREVIEW_GENERATED, OrderStatus.RISK_EVALUATED],
      [OrderStatus.RISK_EVALUATED, OrderStatus.DEPOSIT_PENDING],
      [OrderStatus.RISK_EVALUATED, OrderStatus.READY_TO_SHIP],
      [OrderStatus.DEPOSIT_PENDING, OrderStatus.DEPOSIT_PAID],
      [OrderStatus.DEPOSIT_PAID, OrderStatus.READY_TO_SHIP],
      [OrderStatus.READY_TO_SHIP, OrderStatus.SHIPPED],
      [OrderStatus.SHIPPED, OrderStatus.ACCEPTED],
      [OrderStatus.SHIPPED, OrderStatus.REFUSED],
      // Cancellation from every pre-fulfilment state.
      [OrderStatus.DRAFT, OrderStatus.CANCELLED],
      [OrderStatus.PREVIEW_GENERATED, OrderStatus.CANCELLED],
      [OrderStatus.RISK_EVALUATED, OrderStatus.CANCELLED],
      [OrderStatus.DEPOSIT_PENDING, OrderStatus.CANCELLED],
    ])('allows %s → %s', (from, to) => {
      expect(ORDER_TRANSITIONS[from]).toContain(to);
    });

    it.each([
      // Shipping without the deposit ever being settled.
      [OrderStatus.DRAFT, OrderStatus.SHIPPED],
      [OrderStatus.RISK_EVALUATED, OrderStatus.SHIPPED],
      [OrderStatus.DEPOSIT_PENDING, OrderStatus.READY_TO_SHIP],
      [OrderStatus.DEPOSIT_PENDING, OrderStatus.SHIPPED],
      // Recording an outcome for something that never left the warehouse.
      [OrderStatus.READY_TO_SHIP, OrderStatus.ACCEPTED],
      [OrderStatus.READY_TO_SHIP, OrderStatus.REFUSED],
      [OrderStatus.DEPOSIT_PAID, OrderStatus.ACCEPTED],
      // Walking the lifecycle backwards.
      [OrderStatus.RISK_EVALUATED, OrderStatus.DRAFT],
      [OrderStatus.SHIPPED, OrderStatus.READY_TO_SHIP],
      [OrderStatus.DEPOSIT_PAID, OrderStatus.DEPOSIT_PENDING],
      // Re-evaluating risk after the deposit was priced.
      [OrderStatus.DEPOSIT_PENDING, OrderStatus.RISK_EVALUATED],
      // Cancelling once money is settled or the order is in fulfilment.
      [OrderStatus.DEPOSIT_PAID, OrderStatus.CANCELLED],
      [OrderStatus.READY_TO_SHIP, OrderStatus.CANCELLED],
      [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    ])('forbids %s → %s', (from, to) => {
      expect(ORDER_TRANSITIONS[from]).not.toContain(to);
    });
  });

  it('treats ACCEPTED, REFUSED and CANCELLED as terminal', () => {
    expect(ORDER_TRANSITIONS[OrderStatus.ACCEPTED]).toEqual([]);
    expect(ORDER_TRANSITIONS[OrderStatus.REFUSED]).toEqual([]);
    expect(ORDER_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
  });

  it('leaves no status unreachable from DRAFT', () => {
    const seen = new Set<OrderStatus>([OrderStatus.DRAFT]);
    const queue: OrderStatus[] = [OrderStatus.DRAFT];
    while (queue.length) {
      for (const next of ORDER_TRANSITIONS[queue.shift() as OrderStatus]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL_STATUSES].sort());
  });
});
