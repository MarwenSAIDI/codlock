/**
 * Verifies that a real Supabase/PostgreSQL database has the shape this backend
 * expects. Run after applying db/schema.sql (or the migrations) to confirm the
 * deployment actually landed:
 *
 *     npm run db:verify
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.
 *
 * READ-ONLY. Tables are probed with `limit=0`. The two mutating functions are
 * probed with deliberately non-existent ids so they raise and roll back — that
 * proves the function exists and is callable without writing a row. Nothing in
 * this script inserts, updates or deletes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  let raw = '';
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    console.error('No .env found at the repository root.');
    process.exit(2);
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const TABLES = [
  'customers',
  'products',
  'orders',
  'fitting_sessions',
  'webhook_events',
];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(2);
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const checks: Check[] = [];

  // ── Reachability ────────────────────────────────────────────
  let reachable = false;
  try {
    const res = await fetch(`${url}/rest/v1/`, { headers });
    reachable = res.ok;
    checks.push({
      name: 'PostgREST reachable',
      ok: res.ok,
      detail: `HTTP ${res.status}`,
    });
  } catch (err) {
    checks.push({
      name: 'PostgREST reachable',
      ok: false,
      detail: (err as Error).message,
    });
  }

  if (reachable) {
    // ── Tables ────────────────────────────────────────────────
    for (const table of TABLES) {
      try {
        const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=0`, {
          headers,
        });
        const body = res.ok ? '' : ((await res.json())?.message ?? '');
        checks.push({
          name: `table ${table}`,
          ok: res.ok,
          detail: res.ok ? 'present' : `HTTP ${res.status} ${body}`.trim(),
        });
      } catch (err) {
        checks.push({
          name: `table ${table}`,
          ok: false,
          detail: (err as Error).message,
        });
      }
    }

    // ── Stored functions ──────────────────────────────────────
    const rpc = async (
      fn: string,
      args: Record<string, unknown>,
    ): Promise<{ status: number; message: string }> => {
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      let message = '';
      try {
        message = (await res.json())?.message ?? '';
      } catch {
        /* empty body */
      }
      return { status: res.status, message };
    };

    const NOWHERE = '00000000-0000-4000-8000-000000000000';

    // seller_kpis is `stable` — safe to call for real.
    try {
      const res = await fetch(`${url}/rest/v1/rpc/seller_kpis`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_seller_id: NOWHERE }),
      });
      const body: any = await res.json();
      const shaped =
        res.ok &&
        body &&
        typeof body.totalOrders === 'number' &&
        Array.isArray(body.refusalByZone);
      checks.push({
        name: 'function seller_kpis',
        ok: shaped,
        detail: shaped
          ? `returns the expected shape (totalOrders=${body.totalOrders})`
          : `HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`,
      });
    } catch (err) {
      checks.push({
        name: 'function seller_kpis',
        ok: false,
        detail: (err as Error).message,
      });
    }

    // Mutating functions: a missing id makes them raise before any write.
    const probes: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'record_order_outcome',
        { p_order_id: NOWHERE, p_seller_id: NOWHERE, p_outcome: 'ACCEPTED' },
        /Order not found/i,
      ],
      [
        'process_gravv_webhook',
        {
          p_event_id: '__verify_probe__',
          p_event_type: 'payment.succeeded',
          p_payment_id: '__verify_probe_no_such_payment__',
          p_amount: 1,
          p_currency: 'TND',
        },
        /No order matches payment/i,
      ],
    ];

    for (const [fn, args, expected] of probes) {
      try {
        const { status, message } = await rpc(fn, args);
        const exists = expected.test(message);
        const missing =
          status === 404 || /does not exist|not find/i.test(message);
        checks.push({
          name: `function ${fn}`,
          ok: exists,
          detail: exists
            ? 'present (raised its guard clause, nothing written)'
            : missing
              ? 'MISSING'
              : `HTTP ${status} ${message}`.trim(),
        });
      } catch (err) {
        checks.push({
          name: `function ${fn}`,
          ok: false,
          detail: (err as Error).message,
        });
      }
    }

    // ── Deep introspection ────────────────────────────────────
    // codlock_verify_schema() reports indexes, constraints, grants, RLS and
    // triggers — none of which PostgREST can see directly. Absent on an older
    // deploy, so its own absence is reported rather than failing the run.
    try {
      const res = await fetch(`${url}/rest/v1/rpc/codlock_verify_schema`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      if (res.status === 404) {
        checks.push({
          name: 'schema self-check',
          ok: false,
          detail:
            'codlock_verify_schema() not deployed — apply ' +
            'db/migrations/20260810_verify_schema_fn.sql for deep checks',
        });
      } else {
        const report: any = await res.json();
        const categories = [
          'tables',
          'indexes',
          'constraints',
          'functions',
          'grants',
          'rls',
          'triggers',
        ];
        for (const cat of categories) {
          const c = report?.[cat];
          const detail =
            c?.ok === false
              ? `missing/wrong: ${JSON.stringify(
                  c.missing ?? c.disabled ?? c.wrong ?? [],
                )}`
              : 'present';
          checks.push({ name: `schema · ${cat}`, ok: c?.ok === true, detail });
        }
        const order = Array.isArray(report?.order_status)
          ? report.order_status.join(' > ')
          : '';
        checks.push({
          name: 'schema · order_status enum',
          ok: /DEPOSIT_PAID > READY_TO_SHIP > SHIPPED/.test(order),
          detail: order || 'not found',
        });
      }
    } catch (err) {
      checks.push({
        name: 'schema self-check',
        ok: false,
        detail: (err as Error).message,
      });
    }
  }

  // ── Report ──────────────────────────────────────────────────
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  console.log(`\nCODLOCK database verification — ${host}\n`);
  for (const c of checks) {
    console.log(
      `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(28)} ${c.detail}`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n  ${checks.length - failed.length}/${checks.length} checks passed`,
  );

  if (failed.length) {
    console.log(
      '\n  The database is not fully deployed. Apply db/schema.sql in the\n' +
        '  Supabase SQL editor (or the files in db/migrations/ in filename\n' +
        '  order for an existing database), then re-run this command.\n',
    );
    process.exit(1);
  }
  console.log('\n  Database shape matches what the backend expects.\n');
}

void main();
