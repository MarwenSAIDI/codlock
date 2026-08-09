import {
  Db,
  SELLER_A,
  SELLER_B,
  SQL_FILES,
  applyFile,
  enumValues,
  errorOf,
  executors,
  freshDb,
  functionNames,
  getCustomer,
  getOrder,
  indexNames,
  insertCustomer,
  insertOrder,
  insertProduct,
  newDb,
  readSql,
  rlsEnabled,
  tableNames,
  truncateAll,
  closeAllDbs,
} from './utils/pg-harness';
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Runs db/schema.sql and db/migrations/ against a real PostgreSQL engine
 * (PGlite — genuine PostgreSQL 18 compiled to WASM, full plpgsql support).
 *
 * This is the layer the e2e suite cannot reach: its in-memory Supabase double
 * *models* the stored functions in TypeScript, whereas these tests execute the
 * shipped SQL.
 */

/** The pre-hardening schema, recovered from git so the upgrade path is real. */
function legacySchemaPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codlock-legacy-'));
  const sql = execSync('git show f70ec4e:db/schema.sql', {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const path = join(dir, 'legacy-schema.sql');
  writeFileSync(path, sql);
  return path;
}

jest.setTimeout(120_000);

// PGlite holds WASM handles; release them so Jest exits cleanly.
afterAll(closeAllDbs);

describe('db/schema.sql — fresh install', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });

  it('creates every expected table', async () => {
    expect(await tableNames(db)).toEqual([
      'customers',
      'fitting_sessions',
      'orders',
      'products',
      'webhook_events',
    ]);
  });

  it('creates all three stored functions', async () => {
    const fns = await functionNames(db);
    expect(fns).toEqual(
      expect.arrayContaining([
        'process_gravv_webhook',
        'record_order_outcome',
        'seller_kpis',
        'set_updated_at',
      ]),
    );
  });

  it('orders READY_TO_SHIP between DEPOSIT_PAID and SHIPPED', async () => {
    expect(await enumValues(db, 'order_status')).toEqual([
      'DRAFT',
      'PREVIEW_GENERATED',
      'RISK_EVALUATED',
      'DEPOSIT_PENDING',
      'DEPOSIT_PAID',
      'READY_TO_SHIP',
      'SHIPPED',
      'ACCEPTED',
      'REFUSED',
      'CANCELLED',
    ]);
  });

  it('creates the indexes backing the paginated list queries', async () => {
    expect(await indexNames(db, 'orders')).toEqual(
      expect.arrayContaining([
        'idx_orders_seller_created',
        'idx_orders_payment',
      ]),
    );
    expect(await indexNames(db, 'products')).toEqual(
      expect.arrayContaining(['idx_products_seller_updated']),
    );
    expect(await indexNames(db, 'customers')).toEqual(
      expect.arrayContaining(['idx_customers_seller_updated']),
    );
  });

  it('enables RLS on every business table', async () => {
    for (const table of [
      'customers',
      'products',
      'orders',
      'fitting_sessions',
      'webhook_events',
    ]) {
      expect(await rlsEnabled(db, table)).toBe(true);
    }
  });

  it('is idempotent', async () => {
    await expect(applyFile(db, SQL_FILES.schema)).resolves.not.toThrow();
  });
});

describe('function grants', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });

  it.each([
    'record_order_outcome(uuid, uuid, order_outcome)',
    'process_gravv_webhook(text, text, text, numeric, text)',
    'seller_kpis(uuid)',
    'codlock_verify_schema()',
  ])('%s is executable only by service_role', async (signature) => {
    const granted = await executors(db, signature);
    expect(granted).toEqual({
      public: false,
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });
});

describe('codlock_verify_schema()', () => {
  const report = (db: Db) =>
    db
      .query<{ r: any }>(`select codlock_verify_schema() as r`)
      .then((res) => res.rows[0].r);

  it('reports a fresh schema.sql install as fully healthy', async () => {
    const db = await freshDb();
    const r = await report(db);
    expect(r.ok).toBe(true);
    for (const cat of [
      'tables',
      'indexes',
      'constraints',
      'functions',
      'grants',
      'rls',
      'triggers',
    ]) {
      expect(r[cat].ok).toBe(true);
    }
    expect(r.order_status).toEqual([
      'DRAFT',
      'PREVIEW_GENERATED',
      'RISK_EVALUATED',
      'DEPOSIT_PENDING',
      'DEPOSIT_PAID',
      'READY_TO_SHIP',
      'SHIPPED',
      'ACCEPTED',
      'REFUSED',
      'CANCELLED',
    ]);
  });

  it('reports a fully-migrated legacy database as healthy', async () => {
    const legacy = legacySchemaPath();
    const db = await newDb();
    await applyFile(db, legacy);
    await applyFile(db, SQL_FILES.hardening);
    await applyFile(db, SQL_FILES.kpis);
    await applyFile(db, SQL_FILES.verifyFn);

    const r = await report(db);
    // The migration path enforces customer uniqueness with a bare unique index
    // rather than a table constraint; the check must accept both forms.
    expect(r.ok).toBe(true);
    expect(r.constraints.ok).toBe(true);
  });

  it('flags a missing table', async () => {
    const db = await freshDb();
    await db.exec('drop table fitting_sessions cascade');
    const r = await report(db);
    expect(r.ok).toBe(false);
    expect(r.tables.ok).toBe(false);
    expect(r.tables.missing).toContain('fitting_sessions');
  });

  it('flags RLS being disabled', async () => {
    const db = await freshDb();
    await db.exec('alter table orders disable row level security');
    const r = await report(db);
    expect(r.ok).toBe(false);
    expect(r.rls.ok).toBe(false);
    expect(r.rls.disabled).toContain('orders');
  });

  it('flags a loosened grant', async () => {
    const db = await freshDb();
    await db.exec('grant execute on function seller_kpis(uuid) to anon');
    const r = await report(db);
    expect(r.ok).toBe(false);
    expect(r.grants.ok).toBe(false);
  });
});

describe('record_chat_webhook_event()', () => {
  let db: Db;
  const call = (eventId: string, sentAt: string, skew = 300) =>
    db
      .query<{ r: any }>(
        `select record_chat_webhook_event($1, $2::timestamptz, $3) as r`,
        [eventId, sentAt, skew],
      )
      .then((res) => res.rows[0].r);

  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(() => truncateAll(db));

  it('records a fresh, first-seen event', async () => {
    const r = await call('evt_1', new Date().toISOString());
    expect(r).toEqual({ fresh: true, duplicate: false });
    const rows = await db.query(
      `select provider, payment_id from webhook_events where event_id = 'evt_1'`,
    );
    expect(rows.rows[0]).toMatchObject({ provider: 'CHAT', payment_id: null });
  });

  it('flags a replayed event id as duplicate', async () => {
    const now = new Date().toISOString();
    await call('evt_dup', now);
    expect(await call('evt_dup', now)).toEqual({
      fresh: true,
      duplicate: true,
    });
    const count = await db.query<{ n: number }>(
      `select count(*)::int n from webhook_events where event_id = 'evt_dup'`,
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('rejects a stale timestamp and does not record it', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    expect(await call('evt_stale', old)).toEqual({
      fresh: false,
      duplicate: false,
    });
    const rows = await db.query(
      `select 1 from webhook_events where event_id = 'evt_stale'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects a far-future timestamp too', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(await call('evt_future', future)).toMatchObject({ fresh: false });
  });

  it('release_chat_webhook_event frees an id for retry', async () => {
    const now = new Date().toISOString();
    await call('evt_rel', now);
    expect(await call('evt_rel', now)).toMatchObject({ duplicate: true });

    await db.query(`select release_chat_webhook_event('evt_rel')`);
    expect(await call('evt_rel', now)).toEqual({
      fresh: true,
      duplicate: false,
    });
  });

  it('does not let release touch a Gravv event', async () => {
    await db.query(
      `insert into webhook_events(event_id, provider, event_type, payment_id)
       values ('evt_gravv', 'GRAVV', 'payment.succeeded', 'pay_x')`,
    );
    await db.query(`select release_chat_webhook_event('evt_gravv')`);
    const rows = await db.query(
      `select 1 from webhook_events where event_id = 'evt_gravv'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('is grantable only to service_role', async () => {
    expect(
      await executors(
        db,
        'record_chat_webhook_event(text, timestamptz, integer)',
      ),
    ).toEqual({
      public: false,
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });
});

describe('table constraints', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(() => truncateAll(db));

  it('scopes customer phone uniqueness per seller', async () => {
    await insertCustomer(db, SELLER_A, '+21620000001');
    // Same phone, different seller — allowed.
    await expect(
      insertCustomer(db, SELLER_B, '+21620000001'),
    ).resolves.toBeDefined();
    // Same phone, same seller — rejected.
    const err = await errorOf(
      db,
      `insert into customers (seller_id, phone) values ($1, $2)`,
      [SELLER_A, '+21620000001'],
    );
    expect(err).toMatch(/duplicate key|unique/i);
  });

  it('scopes product sku uniqueness per seller', async () => {
    await insertProduct(db, SELLER_A, 'SKU-1');
    await expect(insertProduct(db, SELLER_B, 'SKU-1')).resolves.toBeDefined();
    const err = await errorOf(
      db,
      `insert into products (seller_id, sku, title, price) values ($1,'SKU-1','x',1)`,
      [SELLER_A],
    );
    expect(err).toMatch(/duplicate key|unique/i);
  });

  it('rejects a negative price and a negative total', async () => {
    expect(
      await errorOf(
        db,
        `insert into products (seller_id, sku, title, price) values ($1,'NEG','x',-1)`,
        [SELLER_A],
      ),
    ).toMatch(/check constraint/i);

    const customerId = await insertCustomer(db, SELLER_A, '+21620000002');
    expect(
      await errorOf(
        db,
        `insert into orders (seller_id, customer_id, channel, total_price)
         values ($1,$2,'INSTAGRAM',-5)`,
        [SELLER_A, customerId],
      ),
    ).toMatch(/check constraint/i);
  });

  it('enforces a three-character currency and the 0-100 risk score', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+21620000003');
    expect(
      await errorOf(
        db,
        `insert into orders (seller_id, customer_id, channel, total_price, currency)
         values ($1,$2,'INSTAGRAM',10,'TUND')`,
        [SELLER_A, customerId],
      ),
    ).toMatch(/check constraint/i);

    expect(
      await errorOf(
        db,
        `insert into orders (seller_id, customer_id, channel, total_price, risk_score)
         values ($1,$2,'INSTAGRAM',10,101)`,
        [SELLER_A, customerId],
      ),
    ).toMatch(/check constraint/i);
  });

  it('allows only one order per payment_id but many with none', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+21620000004');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      paymentId: 'pay_1',
    });
    const err = await errorOf(
      db,
      `insert into orders (seller_id, customer_id, channel, total_price, payment_id)
       values ($1,$2,'INSTAGRAM',10,'pay_1')`,
      [SELLER_A, customerId],
    );
    expect(err).toMatch(/duplicate key|unique/i);

    // Two orders with a NULL payment_id must both be allowed.
    await insertOrder(db, { sellerId: SELLER_A, customerId });
    await expect(
      insertOrder(db, { sellerId: SELLER_A, customerId }),
    ).resolves.toBeDefined();
  });

  it('refuses to delete a customer that still has orders', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+21620000005');
    await insertOrder(db, { sellerId: SELLER_A, customerId });
    expect(
      await errorOf(db, `delete from customers where id = $1`, [customerId]),
    ).toMatch(/foreign key|violates/i);
  });

  it('bumps updated_at via the trigger', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+21620000006');
    const before = (await getCustomer(db, customerId)).updated_at;
    await db.query(`update customers set name = 'Renamed' where id = $1`, [
      customerId,
    ]);
    const after = (await getCustomer(db, customerId)).updated_at;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });
});

describe('record_order_outcome()', () => {
  let db: Db;
  let customerId: string;
  const call = (orderId: string, outcome: string, seller = SELLER_A) =>
    db.query(`select record_order_outcome($1,$2,$3::order_outcome) as r`, [
      orderId,
      seller,
      outcome,
    ]);

  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    customerId = await insertCustomer(db, SELLER_A, '+21620100001');
  });

  it('finalises a shipped order and updates customer aggregates', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });

    await call(orderId, 'ACCEPTED');

    expect(await getOrder(db, orderId)).toMatchObject({
      status: 'ACCEPTED',
      outcome: 'ACCEPTED',
      version: 1,
    });
    expect(await getCustomer(db, customerId)).toMatchObject({
      total_orders: 1,
      successful_orders: 1,
      refused_orders: 0,
    });
  });

  it('counts a refusal against the customer', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });
    await call(orderId, 'REFUSED');
    expect(await getCustomer(db, customerId)).toMatchObject({
      total_orders: 1,
      successful_orders: 0,
      refused_orders: 1,
    });
  });

  it('is an idempotent replay — aggregates are not double-counted', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });
    await call(orderId, 'ACCEPTED');
    await call(orderId, 'ACCEPTED');
    await call(orderId, 'ACCEPTED');

    expect(await getCustomer(db, customerId)).toMatchObject({
      total_orders: 1,
    });
    expect(await getOrder(db, orderId)).toMatchObject({ version: 1 });
  });

  it('rejects an outcome on an order that was never shipped', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'DEPOSIT_PAID',
    });
    await expect(call(orderId, 'ACCEPTED')).rejects.toThrow(
      /Only a SHIPPED order/,
    );
  });

  it('rejects PENDING as an outcome', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });
    await expect(call(orderId, 'PENDING')).rejects.toThrow(
      /must be ACCEPTED or REFUSED/,
    );
  });

  it('refuses to act across a tenant boundary', async () => {
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });
    await expect(call(orderId, 'ACCEPTED', SELLER_B)).rejects.toThrow(
      /Order not found/,
    );
    expect(await getOrder(db, orderId)).toMatchObject({ status: 'SHIPPED' });
  });

  describe('risk tier recalculation', () => {
    const settle = async (accepted: number, refused: number) => {
      for (let i = 0; i < accepted + refused; i++) {
        const orderId = await insertOrder(db, {
          sellerId: SELLER_A,
          customerId,
          status: 'SHIPPED',
        });
        await call(orderId, i < accepted ? 'ACCEPTED' : 'REFUSED');
      }
      return (await getCustomer(db, customerId)).risk_tier;
    };

    it('marks a customer HIGH at a 40% refusal rate', async () => {
      expect(await settle(3, 2)).toBe('HIGH');
    });

    it('marks a spotless customer TRUSTED once they have 3 orders', async () => {
      expect(await settle(3, 0)).toBe('TRUSTED');
    });

    it('keeps a spotless customer MEDIUM below 3 orders', async () => {
      expect(await settle(2, 0)).toBe('MEDIUM');
    });
  });
});

describe('process_gravv_webhook()', () => {
  let db: Db;
  let customerId: string;
  let orderId: string;

  const call = (
    eventId: string,
    type: string,
    paymentId = 'pay_hook',
    amount = 29.8,
    currency = 'TND',
  ) =>
    db.query<{ r: any }>(`select process_gravv_webhook($1,$2,$3,$4,$5) as r`, [
      eventId,
      type,
      paymentId,
      amount,
      currency,
    ]);

  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncateAll(db);
    customerId = await insertCustomer(db, SELLER_A, '+21620200001');
    orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'DEPOSIT_PENDING',
      depositStatus: 'PENDING',
      depositAmount: 29.8,
      paymentId: 'pay_hook',
    });
  });

  it('applies a successful payment', async () => {
    const res = await call('evt_1', 'payment.succeeded');
    expect(res.rows[0].r).toMatchObject({
      orderId,
      applied: 'DEPOSIT_PAID',
      duplicate: false,
    });
    expect(await getOrder(db, orderId)).toMatchObject({
      status: 'DEPOSIT_PAID',
      deposit_status: 'PAID',
      version: 1,
    });
  });

  it('deduplicates a redelivered event without touching the order', async () => {
    await call('evt_1', 'payment.succeeded');
    const replay = await call('evt_1', 'payment.succeeded');

    expect(replay.rows[0].r).toMatchObject({
      applied: 'DUPLICATE',
      duplicate: true,
    });
    expect(await getOrder(db, orderId)).toMatchObject({ version: 1 });
  });

  it('records the event in the ledger and stamps processed_at', async () => {
    await call('evt_1', 'payment.succeeded');
    const res = await db.query<any>(
      `select provider, event_type, payment_id, processed_at
         from webhook_events where event_id = 'evt_1'`,
    );
    expect(res.rows[0]).toMatchObject({
      provider: 'GRAVV',
      event_type: 'payment.succeeded',
      payment_id: 'pay_hook',
    });
    expect(res.rows[0].processed_at).not.toBeNull();
  });

  it('rolls the ledger insert back when the amount does not match', async () => {
    await expect(
      call('evt_bad', 'payment.succeeded', 'pay_hook', 5),
    ).rejects.toThrow(/amount does not match/);

    // The event must NOT be recorded, or a corrected redelivery would be
    // silently swallowed as a duplicate.
    const ledger = await db.query(
      `select 1 from webhook_events where event_id = 'evt_bad'`,
    );
    expect(ledger.rows).toHaveLength(0);
    expect(await getOrder(db, orderId)).toMatchObject({
      deposit_status: 'PENDING',
    });
  });

  it('rolls back when the currency does not match', async () => {
    await expect(
      call('evt_cur', 'payment.succeeded', 'pay_hook', 29.8, 'EUR'),
    ).rejects.toThrow(/currency does not match/);
    const ledger = await db.query(
      `select 1 from webhook_events where event_id = 'evt_cur'`,
    );
    expect(ledger.rows).toHaveLength(0);
  });

  it('accepts a lowercase currency by normalising it', async () => {
    const res = await call(
      'evt_lc',
      'payment.succeeded',
      'pay_hook',
      29.8,
      'tnd',
    );
    expect(res.rows[0].r).toMatchObject({ applied: 'DEPOSIT_PAID' });
  });

  it('rejects an event for an unknown payment', async () => {
    await expect(
      call('evt_x', 'payment.succeeded', 'pay_missing'),
    ).rejects.toThrow(/No order matches payment/);
  });

  it('rejects an unsupported event type', async () => {
    await expect(call('evt_y', 'payment.exploded')).rejects.toThrow(
      /Unsupported payment event type/,
    );
  });

  it('marks a failure without paying the order', async () => {
    const res = await call('evt_f', 'payment.failed');
    expect(res.rows[0].r).toMatchObject({ applied: 'DEPOSIT_FAILED' });
    expect(await getOrder(db, orderId)).toMatchObject({
      status: 'DEPOSIT_PENDING',
      deposit_status: 'FAILED',
    });
  });

  it('marks an expiry', async () => {
    const res = await call('evt_e', 'payment.expired');
    expect(res.rows[0].r).toMatchObject({ applied: 'DEPOSIT_EXPIRED' });
    expect(await getOrder(db, orderId)).toMatchObject({
      deposit_status: 'EXPIRED',
    });
  });

  it('reports ALREADY_PAID for a second distinct success event', async () => {
    await call('evt_1', 'payment.succeeded');
    const res = await call('evt_2', 'payment.succeeded');
    expect(res.rows[0].r).toMatchObject({ applied: 'ALREADY_PAID' });
    expect(await getOrder(db, orderId)).toMatchObject({ version: 1 });
  });

  it('refuses to pay an order that is not awaiting a deposit', async () => {
    await db.query(
      `update orders set status = 'DRAFT', deposit_status = 'NONE' where id = $1`,
      [orderId],
    );
    await expect(call('evt_z', 'payment.succeeded')).rejects.toThrow(
      /not waiting for a deposit/,
    );
  });

  it('does not overpay when the deposit was already settled by failure', async () => {
    await call('evt_f', 'payment.failed');
    const res = await call('evt_f2', 'payment.failed');
    // Already FAILED and no longer transitions; stays consistent.
    expect(res.rows[0].r.duplicate).toBe(false);
    expect(await getOrder(db, orderId)).toMatchObject({
      deposit_status: 'FAILED',
    });
  });
});

describe('seller_kpis()', () => {
  let db: Db;
  const kpis = (seller = SELLER_A) =>
    db
      .query<{ r: any }>(`select seller_kpis($1) as r`, [seller])
      .then((res) => res.rows[0].r);

  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(() => truncateAll(db));

  it('returns zeroed KPIs for a seller with no orders', async () => {
    expect(await kpis()).toMatchObject({
      sellerId: SELLER_A,
      totalOrders: 0,
      acceptedOrders: 0,
      refusedOrders: 0,
      refusalByZone: [],
    });
  });

  it('aggregates money saved and fees recouped', async () => {
    const sfax = await insertCustomer(db, SELLER_A, '+216201', 'Sfax');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: sfax,
      outcome: 'ACCEPTED',
      totalPrice: 100,
    });
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: sfax,
      outcome: 'ACCEPTED',
      totalPrice: 50.5,
    });
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: sfax,
      outcome: 'REFUSED',
      totalPrice: 80,
      depositAmount: 16,
    });

    expect(await kpis()).toMatchObject({
      totalOrders: 3,
      acceptedOrders: 2,
      refusedOrders: 1,
      savedFromAcceptedOrders: 150.5,
      feesCoveredByDeposits: 16,
    });
  });

  it('measures the zone refusal rate over settled orders only', async () => {
    const kairouan = await insertCustomer(db, SELLER_A, '+216202', 'Kairouan');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: kairouan,
      outcome: 'REFUSED',
      depositAmount: 10,
    });
    // Three orders still in flight must not dilute the rate.
    for (let i = 0; i < 3; i++) {
      await insertOrder(db, {
        sellerId: SELLER_A,
        customerId: kairouan,
        outcome: 'PENDING',
      });
    }

    const result = await kpis();
    expect(result.totalOrders).toBe(4);
    expect(result.refusalByZone).toEqual([
      {
        zone: 'Kairouan',
        settledOrders: 1,
        refusedOrders: 1,
        refusalRate: 1,
      },
    ]);
  });

  it('sorts zones by refusal rate descending', async () => {
    const bad = await insertCustomer(db, SELLER_A, '+216203', 'Kairouan');
    const good = await insertCustomer(db, SELLER_A, '+216204', 'Sfax');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: bad,
      outcome: 'REFUSED',
    });
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: good,
      outcome: 'ACCEPTED',
    });

    const result = await kpis();
    expect(result.refusalByZone.map((z: any) => z.zone)).toEqual([
      'Kairouan',
      'Sfax',
    ]);
  });

  it('buckets a null or blank zone as UNKNOWN', async () => {
    const nameless = await insertCustomer(db, SELLER_A, '+216205', null);
    const blank = await insertCustomer(db, SELLER_A, '+216206', '   ');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: nameless,
      outcome: 'ACCEPTED',
    });
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: blank,
      outcome: 'REFUSED',
    });

    const result = await kpis();
    expect(result.refusalByZone).toHaveLength(1);
    expect(result.refusalByZone[0]).toMatchObject({
      zone: 'UNKNOWN',
      settledOrders: 2,
      refusedOrders: 1,
      refusalRate: 0.5,
    });
  });

  it('never leaks another seller data', async () => {
    const mine = await insertCustomer(db, SELLER_A, '+216207', 'Tunis');
    const theirs = await insertCustomer(db, SELLER_B, '+216208', 'Tunis');
    await insertOrder(db, {
      sellerId: SELLER_A,
      customerId: mine,
      outcome: 'ACCEPTED',
      totalPrice: 10,
    });
    await insertOrder(db, {
      sellerId: SELLER_B,
      customerId: theirs,
      outcome: 'ACCEPTED',
      totalPrice: 999,
    });

    expect(await kpis(SELLER_A)).toMatchObject({
      totalOrders: 1,
      savedFromAcceptedOrders: 10,
    });
    expect(await kpis(SELLER_B)).toMatchObject({
      totalOrders: 1,
      savedFromAcceptedOrders: 999,
    });
  });

  it('stays correct past PostgREST row limits', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+216209', 'Sousse');
    const values = Array.from(
      { length: 1500 },
      () =>
        `('${SELLER_A}','${customerId}','INSTAGRAM',10,'ACCEPTED'::order_outcome)`,
    ).join(',');
    await db.exec(
      `insert into orders (seller_id, customer_id, channel, total_price, outcome)
       values ${values}`,
    );

    // The in-memory fold this replaced would have stopped at ~1000 rows.
    expect(await kpis()).toMatchObject({
      totalOrders: 1500,
      acceptedOrders: 1500,
      savedFromAcceptedOrders: 15000,
    });
  });
});

describe('optimistic locking under real contention', () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshDb();
  });
  beforeEach(() => truncateAll(db));

  it('lets exactly one of two concurrent transitions win', async () => {
    const customerId = await insertCustomer(db, SELLER_A, '+216300');
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'READY_TO_SHIP',
    });

    // Both writers read version 0, then both try to advance it — exactly the
    // race OrdersService.persistTransition guards against.
    const transition = () =>
      db.query<{ id: string }>(
        `update orders
            set status = 'SHIPPED', version = version + 1
          where id = $1 and seller_id = $2
            and status = 'READY_TO_SHIP' and version = 0
          returning id`,
        [orderId, SELLER_A],
      );

    const first = await transition();
    const second = await transition();

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
    expect(await getOrder(db, orderId)).toMatchObject({
      status: 'SHIPPED',
      version: 1,
    });
  });
});

describe('migration path from the pre-hardening schema', () => {
  const legacy = legacySchemaPath();

  const legacyDb = async (): Promise<Db> => {
    const db = await newDb();
    await applyFile(db, legacy);
    return db;
  };

  it('the legacy schema genuinely lacks READY_TO_SHIP', async () => {
    const db = await legacyDb();
    expect(await enumValues(db, 'order_status')).not.toContain('READY_TO_SHIP');
  });

  it('upgrades an empty legacy database to the current shape', async () => {
    const db = await legacyDb();
    await applyFile(db, SQL_FILES.hardening);
    await applyFile(db, SQL_FILES.kpis);
    await applyFile(db, SQL_FILES.verifyFn);
    await applyFile(db, SQL_FILES.p1);

    expect(await enumValues(db, 'order_status')).toEqual([
      'DRAFT',
      'PREVIEW_GENERATED',
      'RISK_EVALUATED',
      'DEPOSIT_PENDING',
      'DEPOSIT_PAID',
      'READY_TO_SHIP',
      'SHIPPED',
      'ACCEPTED',
      'REFUSED',
      'CANCELLED',
    ]);
    expect(await functionNames(db)).toEqual(
      expect.arrayContaining([
        'seller_kpis',
        'process_gravv_webhook',
        'record_order_outcome',
        'record_chat_webhook_event',
        'release_chat_webhook_event',
        'codlock_verify_schema',
      ]),
    );
    expect(await tableNames(db)).toContain('webhook_events');

    // The fully-migrated database must pass its own self-check.
    const r = await db.query<{ r: any }>(`select codlock_verify_schema() as r`);
    expect(r.rows[0].r.ok).toBe(true);
  });

  it('survives being wrapped in an explicit transaction', async () => {
    // The Supabase SQL editor wraps pasted statements, and
    // ALTER TYPE ... ADD VALUE is restricted inside transaction blocks.
    const db = await legacyDb();
    const sql = `begin;\n${readSql(SQL_FILES.hardening)}\ncommit;`;
    await expect(db.exec(sql)).resolves.toBeDefined();
    expect(await enumValues(db, 'order_status')).toContain('READY_TO_SHIP');
  });

  it('is idempotent', async () => {
    const db = await legacyDb();
    await applyFile(db, SQL_FILES.hardening);
    await expect(applyFile(db, SQL_FILES.hardening)).resolves.not.toThrow();
    await applyFile(db, SQL_FILES.kpis);
    await expect(applyFile(db, SQL_FILES.kpis)).resolves.not.toThrow();
  });

  it('refuses a legacy database with unattributable customers', async () => {
    const db = await legacyDb();
    await db.query(
      `insert into customers (phone, name) values ('+21620000001','Legacy')`,
    );
    await expect(applyFile(db, SQL_FILES.hardening)).rejects.toThrow(
      /customers has rows but no seller_id column/,
    );
  });

  it('names a remediation the operator can actually perform', async () => {
    // Regression: the guard used to run *after* ADD COLUMN. Because the whole
    // file is one transaction, the rollback removed the column, so the error
    // told operators to backfill a column that no longer existed.
    const db = await legacyDb();
    await db.query(
      `insert into customers (phone, name) values ('+21620000001','Legacy')`,
    );
    await expect(applyFile(db, SQL_FILES.hardening)).rejects.toThrow();

    // Follow the hint, then the migration must succeed.
    await db.query(`alter table customers add column seller_id uuid`);
    await db.query(`update customers set seller_id = $1`, [SELLER_A]);
    await expect(applyFile(db, SQL_FILES.hardening)).resolves.not.toThrow();

    const res = await db.query<any>(`select seller_id from customers`);
    expect(res.rows[0].seller_id).toBe(SELLER_A);
  });

  it('still refuses when the column exists but rows are unattributed', async () => {
    const db = await legacyDb();
    await db.query(
      `insert into customers (phone, name) values ('+21620000002','Legacy')`,
    );
    await db.query(`alter table customers add column seller_id uuid`);
    await expect(applyFile(db, SQL_FILES.hardening)).rejects.toThrow(
      /Backfill customers\.seller_id/,
    );
  });

  it('produces a database the stored functions actually work on', async () => {
    const db = await legacyDb();
    await applyFile(db, SQL_FILES.hardening);
    await applyFile(db, SQL_FILES.kpis);

    const customerId = await insertCustomer(db, SELLER_A, '+21620400001');
    const orderId = await insertOrder(db, {
      sellerId: SELLER_A,
      customerId,
      status: 'SHIPPED',
    });
    await db.query(
      `select record_order_outcome($1,$2,'ACCEPTED'::order_outcome)`,
      [orderId, SELLER_A],
    );

    expect(await getOrder(db, orderId)).toMatchObject({ status: 'ACCEPTED' });
    expect(await kpisOf(db, SELLER_A)).toMatchObject({ acceptedOrders: 1 });
  });

  const kpisOf = (db: Db, seller: string) =>
    db
      .query<{ r: any }>(`select seller_kpis($1) as r`, [seller])
      .then((res) => res.rows[0].r);
});
