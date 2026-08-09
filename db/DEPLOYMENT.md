# CODLOCK — Database Deployment Procedure

The backend talks to Supabase over **PostgREST**, which cannot execute DDL.
Schema deployment is therefore a manual step in the **Supabase SQL editor** (or
`supabase db push` / a direct `psql` connection). The service-role key in `.env`
is not sufficient to create the schema.

Every statement below is **additive and idempotent**. None drops data.

---

## A. Fresh database (current state of the target project)

`npm run db:verify` currently reports the project is empty. Deploy from scratch:

1. Open the Supabase project's **SQL editor**.
2. Paste the **entire contents of `db/schema.sql`** and run it.
3. In the same editor, confirm the shape:

   ```sql
   select codlock_verify_schema();
   ```

   Expect `"ok": true` with every category `ok: true`.
4. From the repo, confirm over the API the backend actually uses:

   ```bash
   npm run db:verify
   ```

   Expect all checks PASS.

---

## B. Existing database created from an older schema

Apply the migrations in **filename order**:

| Order | File | Purpose |
| --- | --- | --- |
| 1 | `db/migrations/20260809_backend_hardening.sql` | seller scoping, `webhook_events`, `READY_TO_SHIP`, hardened functions |
| 2 | `db/migrations/20260809_kpis_rpc_and_indexes.sql` | `seller_kpis`, list-query indexes |
| 3 | `db/migrations/20260810_verify_schema_fn.sql` | `codlock_verify_schema()` self-check |
| 4 | `db/migrations/20260811_p1_hardening.sql` | chat replay ledger, `CANCELLED` state |

**If `customers` already has rows**, migration 1 stops before changing anything
and prints what to do: add the `seller_id` column, set every row to its owning
seller, then re-run. It deliberately refuses to guess ownership.

After the last migration, verify exactly as in steps 3–4 above.

---

## What "verified" covers

`codlock_verify_schema()` and `npm run db:verify` check all seven categories:
**tables, indexes, constraints, functions, grants, RLS, triggers**, plus the
`order_status` enum ordering. The same SQL is exercised on every CI run against
a real PostgreSQL engine by `npm run test:db` (67 tests), including the
fresh-install and legacy-upgrade paths.

## Rollback

These migrations only add objects and loosen one column to nullable. There is
no destructive step to roll back. To discard a **disposable dev** database,
recreate it from `db/schema.sql`; never do this against data you intend to keep.
