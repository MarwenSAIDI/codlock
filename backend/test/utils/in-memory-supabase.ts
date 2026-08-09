import { randomUUID } from 'crypto';
import { SupabaseService } from '../../src/database/supabase/supabase.service';

/**
 * In-memory stand-in for PostgREST + the three `security definer` RPCs.
 *
 * It reproduces the query-builder surface the services actually use so the
 * HTTP layer can be exercised end to end without a database. It is a
 * behavioural model, not the real engine: it does NOT verify the SQL in
 * db/schema.sql, RLS, or PostgREST's own semantics. Those still need a real
 * Supabase instance.
 */

export type Row = Record<string, any>;
export type Store = Record<string, Row[]>;

interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
  count: number | null;
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

/**
 * Column defaults from db/schema.sql. These matter: `orders.version` defaults
 * to 0, and the optimistic-locking filter in OrdersService.persistTransition
 * reads it back on the next transition.
 */
const TABLE_DEFAULTS: Record<string, Row> = {
  orders: {
    item_details: [],
    status: 'DRAFT',
    currency: 'TND',
    risk_score: null,
    deposit_rate: null,
    deposit_amount: null,
    deposit_status: 'NONE',
    payment_id: null,
    payment_url: null,
    outcome: 'PENDING',
    version: 0,
  },
  customers: {
    name: null,
    zone: null,
    total_orders: 0,
    successful_orders: 0,
    refused_orders: 0,
    risk_tier: 'MEDIUM',
  },
  products: { sizes: [], colors: [], image_url: null, category: null },
  fitting_sessions: { order_id: null, preview_photo_url: null },
};

class FakeQuery implements PromiseLike<Result> {
  private eqFilters: Array<[string, unknown]> = [];
  private inFilter: [string, unknown[]] | null = null;
  private sort: { column: string; ascending: boolean } | null = null;
  private rangeSpec: [number, number] | null = null;
  private wantCount = false;
  private cardinality: 'single' | 'maybeSingle' | null = null;
  private conflictKeys: string[] = [];

  constructor(
    private readonly store: Store,
    private readonly table: string,
    private readonly op: Op,
    private readonly payload?: Row | Row[],
    private readonly options?: { onConflict?: string },
  ) {
    if (options?.onConflict) {
      this.conflictKeys = options.onConflict.split(',').map((k) => k.trim());
    }
  }

  select(_columns?: string, options?: { count?: string }): this {
    if (options?.count) this.wantCount = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.eqFilters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.inFilter = [column, values];
    return this;
  }

  order(column: string, opts: { ascending: boolean }): this {
    this.sort = { column, ascending: opts.ascending };
    return this;
  }

  range(from: number, to: number): this {
    this.rangeSpec = [from, to];
    return this;
  }

  single(): this {
    this.cardinality = 'single';
    return this;
  }

  maybeSingle(): this {
    this.cardinality = 'maybeSingle';
    return this;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    return (this.store[this.table] ??= []);
  }

  private matches(row: Row): boolean {
    for (const [column, value] of this.eqFilters) {
      if (row[column] !== value) return false;
    }
    if (this.inFilter && !this.inFilter[1].includes(row[this.inFilter[0]])) {
      return false;
    }
    return true;
  }

  private shape(matched: Row[], total: number): Result {
    if (this.cardinality === 'single') {
      if (matched.length !== 1) {
        return {
          data: null,
          error: { message: 'JSON object requested, multiple (or no) rows' },
          count: null,
        };
      }
      return { data: { ...matched[0] }, error: null, count: null };
    }
    if (this.cardinality === 'maybeSingle') {
      if (matched.length > 1) {
        return {
          data: null,
          error: { message: 'multiple rows returned' },
          count: null,
        };
      }
      return {
        data: matched.length ? { ...matched[0] } : null,
        error: null,
        count: null,
      };
    }
    return {
      data: matched.map((r) => ({ ...r })),
      error: null,
      count: this.wantCount ? total : null,
    };
  }

  private uniqueViolation(candidate: Row): string | null {
    const constraints: Record<string, string[][]> = {
      customers: [['seller_id', 'phone']],
      products: [['seller_id', 'sku']],
      orders: [['payment_id']],
    };
    for (const keys of constraints[this.table] ?? []) {
      if (keys.some((k) => candidate[k] === undefined || candidate[k] === null))
        continue;
      const clash = this.rows().some(
        (r) =>
          r.id !== candidate.id && keys.every((k) => r[k] === candidate[k]),
      );
      if (clash) {
        return `duplicate key value violates unique constraint on (${keys.join(', ')})`;
      }
    }
    return null;
  }

  private run(): Result {
    const now = new Date().toISOString();

    if (this.op === 'insert' || this.op === 'upsert') {
      const incoming = (
        Array.isArray(this.payload) ? this.payload : [this.payload]
      ) as Row[];
      const written: Row[] = [];

      for (const values of incoming) {
        const existing =
          this.op === 'upsert' && this.conflictKeys.length
            ? this.rows().find((r) =>
                this.conflictKeys.every((k) => r[k] === values[k]),
              )
            : undefined;

        if (existing) {
          Object.assign(existing, values, { updated_at: now });
          written.push(existing);
          continue;
        }

        const row: Row = {
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...(TABLE_DEFAULTS[this.table] ?? {}),
          ...values,
        };
        const violation = this.uniqueViolation(row);
        if (violation)
          return {
            // SQLSTATE 23505, as PostgREST would return it, so the real
            // unwrap() error mapping (409) is exercised end to end.
            data: null,
            error: { message: violation, code: '23505' },
            count: null,
          };
        this.rows().push(row);
        written.push(row);
      }
      return this.shape(written, written.length);
    }

    if (this.op === 'update') {
      const matched = this.rows().filter((r) => this.matches(r));
      for (const row of matched) Object.assign(row, this.payload);
      return this.shape(matched, matched.length);
    }

    if (this.op === 'delete') {
      const kept: Row[] = [];
      const removed: Row[] = [];
      for (const row of this.rows()) {
        (this.matches(row) ? removed : kept).push(row);
      }
      this.store[this.table] = kept;
      return this.shape(removed, removed.length);
    }

    let matched = this.rows().filter((r) => this.matches(r));
    if (this.sort) {
      const { column, ascending } = this.sort;
      matched = [...matched].sort((a, b) => {
        const av = a[column] ?? '';
        const bv = b[column] ?? '';
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    const total = matched.length;
    if (this.rangeSpec) {
      matched = matched.slice(this.rangeSpec[0], this.rangeSpec[1] + 1);
    }
    return this.shape(matched, total);
  }
}

/** Mirrors the semantics of the plpgsql functions in db/schema.sql. */
function runRpc(store: Store, fn: string, args: Row): Result {
  const orders = (store.orders ??= []);
  const customers = (store.customers ??= []);
  const events = (store.webhook_events ??= []);
  const fail = (message: string): Result => ({
    data: null,
    error: { message },
    count: null,
  });

  if (fn === 'record_chat_webhook_event') {
    const { p_event_id, p_sent_at, p_max_skew_seconds } = args as Record<
      string,
      string & number
    >;
    const skewMs = Number(p_max_skew_seconds) * 1000;
    const sent = new Date(p_sent_at).getTime();
    if (Math.abs(Date.now() - sent) > skewMs) {
      return {
        data: { fresh: false, duplicate: false },
        error: null,
        count: null,
      };
    }
    if (events.some((e) => e.event_id === p_event_id)) {
      return {
        data: { fresh: true, duplicate: true },
        error: null,
        count: null,
      };
    }
    events.push({
      event_id: p_event_id,
      provider: 'CHAT',
      event_type: 'chat.order',
      payment_id: null,
    });
    return {
      data: { fresh: true, duplicate: false },
      error: null,
      count: null,
    };
  }

  if (fn === 'release_chat_webhook_event') {
    const { p_event_id } = args as Record<string, string>;
    const i = events.findIndex(
      (e) => e.event_id === p_event_id && e.provider === 'CHAT',
    );
    if (i >= 0) events.splice(i, 1);
    return { data: null, error: null, count: null };
  }

  if (fn === 'record_order_outcome') {
    const { p_order_id, p_seller_id, p_outcome } = args;
    if (!['ACCEPTED', 'REFUSED'].includes(p_outcome as string)) {
      return fail('Outcome must be ACCEPTED or REFUSED');
    }
    const order = orders.find(
      (o) => o.id === p_order_id && o.seller_id === p_seller_id,
    );
    if (!order) return fail('Order not found');
    if (order.outcome === p_outcome && order.status === p_outcome) {
      return { data: { ...order }, error: null, count: null };
    }
    if (order.status !== 'SHIPPED') {
      return fail('Only a SHIPPED order can receive an outcome');
    }
    order.status = p_outcome;
    order.outcome = p_outcome;
    order.version += 1;

    const customer = customers.find(
      (c) => c.id === order.customer_id && c.seller_id === p_seller_id,
    );
    if (!customer) return fail('Customer not found for seller');
    customer.total_orders += 1;
    if (p_outcome === 'ACCEPTED') customer.successful_orders += 1;
    else customer.refused_orders += 1;
    const rate = customer.refused_orders / customer.total_orders;
    customer.risk_tier =
      rate >= 0.4
        ? 'HIGH'
        : rate <= 0.1 && customer.total_orders >= 3
          ? 'TRUSTED'
          : 'MEDIUM';
    return { data: { ...order }, error: null, count: null };
  }

  if (fn === 'process_gravv_webhook') {
    const { p_event_id, p_event_type, p_payment_id, p_amount, p_currency } =
      args as Record<string, string & number>;
    const firstDelivery = !events.some((e) => e.event_id === p_event_id);
    if (firstDelivery) {
      events.push({
        event_id: p_event_id,
        provider: 'GRAVV',
        event_type: p_event_type,
        payment_id: p_payment_id,
      });
    }

    const order = orders.find((o) => o.payment_id === p_payment_id);
    if (!order) {
      // The real function raises, which rolls the event insert back.
      if (firstDelivery) events.pop();
      return fail(`No order matches payment ${String(p_payment_id)}`);
    }
    if (!firstDelivery) {
      return {
        data: { orderId: order.id, applied: 'DUPLICATE', duplicate: true },
        error: null,
        count: null,
      };
    }
    const rollback = () => {
      events.pop();
    };
    if (order.currency !== String(p_currency).toUpperCase()) {
      rollback();
      return fail('Payment currency does not match the order');
    }
    if (
      Number(order.deposit_amount) !==
      Math.round(Number(p_amount) * 100) / 100
    ) {
      rollback();
      return fail('Payment amount does not match the expected deposit');
    }

    let applied = 'IGNORED';
    if (p_event_type === 'payment.succeeded') {
      if (order.deposit_status === 'PAID') {
        applied = 'ALREADY_PAID';
      } else if (order.status !== 'DEPOSIT_PENDING') {
        rollback();
        return fail('Order is not waiting for a deposit');
      } else {
        order.status = 'DEPOSIT_PAID';
        order.deposit_status = 'PAID';
        order.version += 1;
        applied = 'DEPOSIT_PAID';
      }
    } else if (['payment.failed', 'payment.expired'].includes(p_event_type)) {
      if (
        order.status === 'DEPOSIT_PENDING' &&
        order.deposit_status !== 'PAID'
      ) {
        order.deposit_status =
          p_event_type === 'payment.expired' ? 'EXPIRED' : 'FAILED';
        order.version += 1;
        applied =
          p_event_type === 'payment.expired'
            ? 'DEPOSIT_EXPIRED'
            : 'DEPOSIT_FAILED';
      }
    } else {
      rollback();
      return fail('Unsupported payment event type');
    }

    return {
      data: { orderId: order.id, applied, duplicate: false },
      error: null,
      count: null,
    };
  }

  if (fn === 'seller_kpis') {
    const sellerId = args.p_seller_id as string;
    const scoped: Row[] = orders
      .filter((o) => o.seller_id === sellerId)
      .map((o) => ({
        ...o,
        zone:
          customers.find((c) => c.id === o.customer_id)?.zone?.trim() ||
          'UNKNOWN',
      }));
    const round = (n: number, dp: number) =>
      Math.round(n * 10 ** dp) / 10 ** dp;

    const zones = new Map<string, { settled: number; refused: number }>();
    for (const o of scoped) {
      const z = zones.get(o.zone) ?? { settled: 0, refused: 0 };
      if (o.outcome !== 'PENDING') z.settled += 1;
      if (o.outcome === 'REFUSED') z.refused += 1;
      zones.set(o.zone, z);
    }

    return {
      data: {
        sellerId,
        totalOrders: scoped.length,
        acceptedOrders: scoped.filter((o) => o.outcome === 'ACCEPTED').length,
        refusedOrders: scoped.filter((o) => o.outcome === 'REFUSED').length,
        savedFromAcceptedOrders: round(
          scoped
            .filter((o) => o.outcome === 'ACCEPTED')
            .reduce((s, o) => s + Number(o.total_price ?? 0), 0),
          2,
        ),
        feesCoveredByDeposits: round(
          scoped
            .filter((o) => o.outcome === 'REFUSED')
            .reduce((s, o) => s + Number(o.deposit_amount ?? 0), 0),
          2,
        ),
        refusalByZone: [...zones.entries()]
          .filter(([, s]) => s.settled > 0)
          .map(([zone, s]) => ({
            zone,
            settledOrders: s.settled,
            refusedOrders: s.refused,
            refusalRate: round(s.refused / s.settled, 3),
          }))
          .sort(
            (a, b) =>
              b.refusalRate - a.refusalRate || a.zone.localeCompare(b.zone),
          ),
      },
      error: null,
      count: null,
    };
  }

  return fail(`Unknown function ${fn}`);
}

/**
 * Real SupabaseService (so `unwrap` and its error mapping are the production
 * code) wired to the in-memory client instead of PostgREST.
 */
export class InMemorySupabaseService extends SupabaseService {
  private readonly fakeClient: any;

  constructor(public readonly store: Store = {}) {
    super({ get: () => undefined } as never);
    const store_ = this.store;
    this.fakeClient = {
      from(table: string) {
        return {
          select: (columns?: string, options?: { count?: string }) =>
            new FakeQuery(store_, table, 'select').select(columns, options),
          insert: (payload: Row | Row[]) =>
            new FakeQuery(store_, table, 'insert', payload),
          upsert: (payload: Row, options?: { onConflict?: string }) =>
            new FakeQuery(store_, table, 'upsert', payload, options),
          update: (payload: Row) =>
            new FakeQuery(store_, table, 'update', payload),
          delete: () => new FakeQuery(store_, table, 'delete'),
        };
      },
      rpc: (fn: string, args: Row) => Promise.resolve(runRpc(store_, fn, args)),
    };
  }

  onModuleInit(): void {
    /* no external client to initialise */
  }

  get client(): any {
    return this.fakeClient;
  }

  table(name: string): any {
    return this.fakeClient.from(name);
  }
}
