import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * A real PostgreSQL engine for testing db/schema.sql and db/migrations/.
 *
 * PGlite is genuine PostgreSQL compiled to WASM — plpgsql, triggers, enums,
 * `for update`, transactions and constraints all behave as they do on the
 * server. It is not a model or a mock.
 *
 * Fidelity gaps to keep in mind:
 *  - Supabase's PostgREST layer is absent, so this covers SQL, not the REST
 *    semantics the app actually talks to.
 *  - Supabase's roles do not exist by default; `bootstrapRoles` creates them
 *    so the grant/revoke statements in the schema are genuinely exercised.
 *  - Row Level Security is enabled by the schema but never enforced here,
 *    because every statement runs as the superuser (which bypasses RLS) —
 *    the same way the backend's service-role key does in production.
 */

export const REPO_ROOT = join(__dirname, '..', '..');

export const SQL_FILES = {
  schema: join(REPO_ROOT, 'db', 'schema.sql'),
  hardening: join(
    REPO_ROOT,
    'db',
    'migrations',
    '20260809_backend_hardening.sql',
  ),
  kpis: join(
    REPO_ROOT,
    'db',
    'migrations',
    '20260809_kpis_rpc_and_indexes.sql',
  ),
  verifyFn: join(
    REPO_ROOT,
    'db',
    'migrations',
    '20260810_verify_schema_fn.sql',
  ),
  p1: join(REPO_ROOT, 'db', 'migrations', '20260811_p1_hardening.sql'),
};

export type Db = PGlite;

/** Supabase ships these roles; the schema's grants reference them by name. */
const BOOTSTRAP_ROLES = `
  do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;
`;

/** Every instance created, so the suite can release them and let Jest exit. */
const openDbs: Db[] = [];

export async function newDb(): Promise<Db> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  await db.exec(BOOTSTRAP_ROLES);
  openDbs.push(db);
  return db;
}

export async function closeAllDbs(): Promise<void> {
  await Promise.all(openDbs.splice(0).map((db) => db.close()));
}

/**
 * Empties every business table while leaving the schema in place.
 *
 * Booting PGlite costs ~2.7s, so suites that only need clean *data* share one
 * instance and truncate between tests rather than rebuilding the database.
 * Suites that exercise DDL still take a fresh instance each time.
 */
export async function truncateAll(db: Db): Promise<void> {
  await db.exec(
    `truncate table fitting_sessions, webhook_events, orders, products, customers
     restart identity cascade`,
  );
}

export function readSql(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Applies a SQL file the way an operator would paste it into the Supabase SQL
 * editor: the whole file at once, so multi-statement and transaction-block
 * behaviour is exercised rather than sidestepped.
 */
export async function applyFile(db: Db, path: string): Promise<void> {
  await db.exec(readSql(path));
}

/** Fresh database with the current schema applied. */
export async function freshDb(): Promise<Db> {
  const db = await newDb();
  await applyFile(db, SQL_FILES.schema);
  return db;
}

// ── Introspection helpers ──────────────────────────────────────

export async function tableNames(db: Db): Promise<string[]> {
  const res = await db.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return res.rows.map((r) => r.tablename);
}

export async function enumValues(db: Db, typeName: string): Promise<string[]> {
  const res = await db.query<{ label: string }>(
    `select e.enumlabel as label
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = $1
      order by e.enumsortorder`,
    [typeName],
  );
  return res.rows.map((r) => r.label);
}

export async function functionNames(db: Db): Promise<string[]> {
  const res = await db.query<{ proname: string }>(
    `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by p.proname`,
  );
  return res.rows.map((r) => r.proname);
}

export async function indexNames(db: Db, table: string): Promise<string[]> {
  const res = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public' and tablename = $1
      order by indexname`,
    [table],
  );
  return res.rows.map((r) => r.indexname);
}

export async function rlsEnabled(db: Db, table: string): Promise<boolean> {
  const res = await db.query<{ relrowsecurity: boolean }>(
    `select c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1`,
    [table],
  );
  return res.rows[0]?.relrowsecurity ?? false;
}

/** Roles holding EXECUTE on a function, as `has_function_privilege` sees it. */
export async function executors(
  db: Db,
  signature: string,
): Promise<Record<string, boolean>> {
  const roles = ['public', 'anon', 'authenticated', 'service_role'];
  const out: Record<string, boolean> = {};
  for (const role of roles) {
    const res = await db.query<{ ok: boolean }>(
      `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
      [role, signature],
    );
    out[role] = res.rows[0].ok;
  }
  return out;
}

/** Runs a statement and returns the PostgreSQL error message, or null. */
export async function errorOf(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ── Seed helpers ───────────────────────────────────────────────

export const SELLER_A = '11111111-1111-4111-8111-111111111111';
export const SELLER_B = '22222222-2222-4222-8222-222222222222';

export async function insertCustomer(
  db: Db,
  sellerId: string,
  phone: string,
  zone: string | null = 'Sfax',
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into customers (seller_id, phone, zone) values ($1, $2, $3) returning id`,
    [sellerId, phone, zone],
  );
  return res.rows[0].id;
}

export async function insertProduct(
  db: Db,
  sellerId: string,
  sku: string,
  price = 79.9,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into products (seller_id, sku, title, price, sizes, colors)
     values ($1, $2, 'Test product', $3, '{S,M,L}', '{black}') returning id`,
    [sellerId, sku, price],
  );
  return res.rows[0].id;
}

export interface OrderSeed {
  sellerId: string;
  customerId: string;
  status?: string;
  depositStatus?: string;
  depositAmount?: number | null;
  totalPrice?: number;
  currency?: string;
  paymentId?: string | null;
  outcome?: string;
}

export async function insertOrder(db: Db, seed: OrderSeed): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into orders (
       seller_id, customer_id, channel, status, deposit_status,
       deposit_amount, total_price, currency, payment_id, outcome
     ) values ($1, $2, 'INSTAGRAM', $3::order_status, $4::deposit_status,
               $5, $6, $7, $8, $9::order_outcome)
     returning id`,
    [
      seed.sellerId,
      seed.customerId,
      seed.status ?? 'DRAFT',
      seed.depositStatus ?? 'NONE',
      seed.depositAmount ?? null,
      seed.totalPrice ?? 149,
      seed.currency ?? 'TND',
      seed.paymentId ?? null,
      seed.outcome ?? 'PENDING',
    ],
  );
  return res.rows[0].id;
}

export async function getOrder(
  db: Db,
  id: string,
): Promise<Record<string, any>> {
  const res = await db.query<Record<string, any>>(
    `select * from orders where id = $1`,
    [id],
  );
  return res.rows[0];
}

export async function getCustomer(
  db: Db,
  id: string,
): Promise<Record<string, any>> {
  const res = await db.query<Record<string, any>>(
    `select * from customers where id = $1`,
    [id],
  );
  return res.rows[0];
}
