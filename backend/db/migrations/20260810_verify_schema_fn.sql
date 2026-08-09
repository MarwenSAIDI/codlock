-- CODLOCK schema self-check.
--
-- A read-only introspection function so the deployed database can be verified
-- across all seven object categories through PostgREST RPC — indexes, RLS,
-- grants and triggers are not otherwise reachable over the REST API.
--
-- Purely diagnostic: it reads pg_catalog / information_schema and writes
-- nothing. Safe to run on production at any time. Apply after schema.sql (it is
-- also included at the end of schema.sql for fresh installs).

-- True when `table` has a unique index (constraint-backed or standalone) whose
-- columns are exactly `cols`, in any order.
create or replace function codlock_has_unique_index(
  p_table text,
  p_cols text[]
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from pg_index ix
    join pg_class c on c.oid = ix.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = p_table
      and ix.indisunique
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(ix.indkey) as k(attnum)
        join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
      ) = (select array_agg(x order by x) from unnest(p_cols) as x)
  );
$$;

revoke all on function codlock_has_unique_index(text, text[])
  from public, anon, authenticated;
grant execute on function codlock_has_unique_index(text, text[]) to service_role;

create or replace function codlock_verify_schema()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_expected_tables text[] := array[
    'customers', 'products', 'orders', 'fitting_sessions', 'webhook_events'
  ];
  v_expected_functions text[] := array[
    'record_order_outcome', 'process_gravv_webhook', 'seller_kpis'
  ];
  v_expected_indexes text[] := array[
    'idx_orders_seller_created', 'idx_orders_payment',
    'idx_products_seller_updated', 'idx_customers_seller_updated',
    'idx_webhook_events_payment'
  ];
  v_missing_tables text[];
  v_missing_functions text[];
  v_missing_indexes text[];
  v_rls_disabled text[];
  v_untriggered text[];
  v_bad_grants text[];
  v_missing_constraints text[];
  v_order_status text[];
  v_ok boolean;
begin
  -- Tables ----------------------------------------------------------------
  select coalesce(array_agg(t), '{}')
    into v_missing_tables
  from unnest(v_expected_tables) t
  where not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = t
  );

  -- Functions -------------------------------------------------------------
  select coalesce(array_agg(f), '{}')
    into v_missing_functions
  from unnest(v_expected_functions) f
  where not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f
  );

  -- Indexes ---------------------------------------------------------------
  select coalesce(array_agg(i), '{}')
    into v_missing_indexes
  from unnest(v_expected_indexes) i
  where not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = i
  );

  -- RLS enabled on every business table -----------------------------------
  select coalesce(array_agg(t), '{}')
    into v_rls_disabled
  from unnest(v_expected_tables) t
  join pg_class c on c.relname = t
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relrowsecurity = false;

  -- updated_at triggers where the column exists ---------------------------
  select coalesce(array_agg(t), '{}')
    into v_untriggered
  from unnest(array['customers', 'products', 'orders']) t
  where not exists (
    select 1 from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t and not tg.tgisinternal
  );

  -- Function grants: service_role only ------------------------------------
  select coalesce(array_agg(sig), '{}')
    into v_bad_grants
  from (
    select 'record_order_outcome(uuid, uuid, order_outcome)' as sig
    union all select 'process_gravv_webhook(text, text, text, numeric, text)'
    union all select 'seller_kpis(uuid)'
  ) s
  where has_function_privilege('anon', s.sig, 'EXECUTE')
     or has_function_privilege('authenticated', s.sig, 'EXECUTE')
     or has_function_privilege('public', s.sig, 'EXECUTE')
     or not has_function_privilege('service_role', s.sig, 'EXECUTE');

  -- Key constraints -------------------------------------------------------
  -- Uniqueness is checked via pg_index (indisunique), which matches BOTH a
  -- table constraint and a bare unique index — fresh schema.sql uses the
  -- former for customers, the hardening migration the latter. Both enforce
  -- the same rule, so the verifier asserts the invariant, not the object.
  select coalesce(array_agg(name), '{}')
    into v_missing_constraints
  from (
    select 'customers.unique(seller_id,phone)' as name
      where not codlock_has_unique_index('customers', array['seller_id', 'phone'])
    union all
    select 'products.unique(seller_id,sku)'
      where not codlock_has_unique_index('products', array['seller_id', 'sku'])
    union all
    select 'orders.total_price>=0'
      where not exists (
        select 1 from pg_constraint
         where conrelid = 'public.orders'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) ilike '%total_price%')
  ) c;

  -- order_status enum ordering --------------------------------------------
  select array_agg(e.enumlabel order by e.enumsortorder)
    into v_order_status
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  where t.typname = 'order_status';

  v_ok :=
    array_length(v_missing_tables, 1) is null
    and array_length(v_missing_functions, 1) is null
    and array_length(v_missing_indexes, 1) is null
    and array_length(v_rls_disabled, 1) is null
    and array_length(v_untriggered, 1) is null
    and array_length(v_bad_grants, 1) is null
    and array_length(v_missing_constraints, 1) is null;

  return jsonb_build_object(
    'ok', v_ok,
    'tables', jsonb_build_object(
      'ok', array_length(v_missing_tables, 1) is null,
      'missing', to_jsonb(v_missing_tables)),
    'functions', jsonb_build_object(
      'ok', array_length(v_missing_functions, 1) is null,
      'missing', to_jsonb(v_missing_functions)),
    'indexes', jsonb_build_object(
      'ok', array_length(v_missing_indexes, 1) is null,
      'missing', to_jsonb(v_missing_indexes)),
    'rls', jsonb_build_object(
      'ok', array_length(v_rls_disabled, 1) is null,
      'disabled', to_jsonb(v_rls_disabled)),
    'triggers', jsonb_build_object(
      'ok', array_length(v_untriggered, 1) is null,
      'missing', to_jsonb(v_untriggered)),
    'grants', jsonb_build_object(
      'ok', array_length(v_bad_grants, 1) is null,
      'wrong', to_jsonb(v_bad_grants)),
    'constraints', jsonb_build_object(
      'ok', array_length(v_missing_constraints, 1) is null,
      'missing', to_jsonb(v_missing_constraints)),
    'order_status', to_jsonb(v_order_status)
  );
end;
$$;

revoke all on function codlock_verify_schema() from public, anon, authenticated;
grant execute on function codlock_verify_schema() to service_role;
