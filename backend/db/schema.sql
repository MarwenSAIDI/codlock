-- ─────────────────────────────────────────────────────────────
-- CODLOCK — Supabase (PostgreSQL) schema
-- Run in the Supabase SQL editor or via `supabase db push`.
-- ─────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────
do $$ begin
  create type risk_tier as enum ('TRUSTED', 'MEDIUM', 'HIGH');
exception when duplicate_object then null; end $$;

do $$ begin
  create type channel as enum ('WHATSAPP', 'INSTAGRAM');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum (
    'DRAFT', 'PREVIEW_GENERATED', 'RISK_EVALUATED', 'DEPOSIT_PENDING',
    'DEPOSIT_PAID', 'READY_TO_SHIP', 'SHIPPED', 'ACCEPTED', 'REFUSED',
    'CANCELLED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type deposit_status as enum ('NONE', 'PENDING', 'PAID', 'FAILED', 'EXPIRED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_outcome as enum ('PENDING', 'ACCEPTED', 'REFUSED');
exception when duplicate_object then null; end $$;

-- ── updated_at trigger helper ────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ── Customers ────────────────────────────────────────────────
create table if not exists customers (
  id                uuid primary key default gen_random_uuid(),
  seller_id         uuid not null,
  phone             text not null,
  name              text,
  zone              text,
  total_orders      integer not null default 0,
  successful_orders integer not null default 0,
  refused_orders    integer not null default 0,
  risk_tier         risk_tier not null default 'MEDIUM',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (seller_id, phone)
);
-- `unique (seller_id, phone)` above already provides the (seller_id, phone)
-- lookup index; this one backs the recently-updated-first customer list.
create index if not exists idx_customers_seller_updated
  on customers (seller_id, updated_at desc);

drop trigger if exists trg_customers_updated on customers;
create trigger trg_customers_updated before update on customers
  for each row execute function set_updated_at();

-- ── Products (catalog / SKUs) ────────────────────────────────
create table if not exists products (
  id         uuid primary key default gen_random_uuid(),
  seller_id  uuid not null,
  sku        text not null,
  title      text not null,
  price      numeric(12,2) not null check (price >= 0),
  sizes      text[] not null default '{}',
  colors     text[] not null default '{}',
  image_url  text,
  category   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id, sku)
);
create index if not exists idx_products_seller_updated
  on products (seller_id, updated_at desc);

drop trigger if exists trg_products_updated on products;
create trigger trg_products_updated before update on products
  for each row execute function set_updated_at();

-- ── Orders ───────────────────────────────────────────────────
create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers(id) on delete restrict,
  seller_id      uuid not null,
  channel        channel not null,
  item_details   jsonb not null default '[]',
  status         order_status not null default 'DRAFT',
  total_price    numeric(12,2) not null check (total_price >= 0),
  currency       text not null default 'TND' check (char_length(currency) = 3),
  risk_score     integer check (risk_score between 0 and 100),
  deposit_rate   numeric(4,3) check (deposit_rate between 0 and 1),
  deposit_amount numeric(12,2),
  deposit_status deposit_status not null default 'NONE',
  payment_id     text,
  payment_url    text,
  outcome        order_outcome not null default 'PENDING',
  version        integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_orders_seller_created
  on orders (seller_id, created_at desc);
create index if not exists idx_orders_customer on orders (customer_id);
create index if not exists idx_orders_status on orders (status);
create unique index if not exists idx_orders_payment on orders (payment_id) where payment_id is not null;

drop trigger if exists trg_orders_updated on orders;
create trigger trg_orders_updated before update on orders
  for each row execute function set_updated_at();

-- ── Fitting sessions ─────────────────────────────────────────
create table if not exists fitting_sessions (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid references orders(id) on delete set null,
  customer_id        uuid not null references customers(id) on delete cascade,
  product_id         uuid not null references products(id) on delete cascade,
  original_photo_url text not null,
  preview_photo_url  text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_fitting_order on fitting_sessions (order_id);

-- Durable provider-event ledger, shared by Gravv and the chat webhook. The
-- primary key makes delivery idempotent even when a provider retries for days.
-- payment_id is nullable: chat events carry no payment.
create table if not exists webhook_events (
  event_id      text primary key,
  provider      text not null,
  event_type    text not null,
  payment_id    text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists idx_webhook_events_payment on webhook_events (payment_id);

-- Atomically finalise an order and update the customer's aggregates. Replays
-- of the same outcome return the existing order without incrementing twice.
create or replace function record_order_outcome(
  p_order_id uuid,
  p_seller_id uuid,
  p_outcome order_outcome
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
begin
  if p_outcome not in ('ACCEPTED', 'REFUSED') then
    raise exception 'Outcome must be ACCEPTED or REFUSED';
  end if;

  select * into v_order
  from orders
  where id = p_order_id and seller_id = p_seller_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.outcome = p_outcome and v_order.status::text = p_outcome::text then
    return to_jsonb(v_order);
  end if;

  if v_order.status <> 'SHIPPED' then
    raise exception 'Only a SHIPPED order can receive an outcome';
  end if;

  update orders
  set status = p_outcome::text::order_status,
      outcome = p_outcome,
      version = version + 1
  where id = p_order_id
  returning * into v_order;

  update customers
  set total_orders = total_orders + 1,
      successful_orders = successful_orders + case when p_outcome = 'ACCEPTED' then 1 else 0 end,
      refused_orders = refused_orders + case when p_outcome = 'REFUSED' then 1 else 0 end,
      risk_tier = case
        when (refused_orders + case when p_outcome = 'REFUSED' then 1 else 0 end)::numeric
             / (total_orders + 1) >= 0.4 then 'HIGH'::risk_tier
        when (refused_orders + case when p_outcome = 'REFUSED' then 1 else 0 end)::numeric
             / (total_orders + 1) <= 0.1 and total_orders + 1 >= 3 then 'TRUSTED'::risk_tier
        else 'MEDIUM'::risk_tier
      end
  where id = v_order.customer_id and seller_id = p_seller_id;

  if not found then
    raise exception 'Customer not found for seller';
  end if;

  return to_jsonb(v_order);
end;
$$;

revoke all on function record_order_outcome(uuid, uuid, order_outcome)
  from public, anon, authenticated;
grant execute on function record_order_outcome(uuid, uuid, order_outcome)
  to service_role;

-- Verify and apply a normalised Gravv event in one transaction. Signature
-- verification remains in NestJS; this function owns deduplication and state.
create or replace function process_gravv_webhook(
  p_event_id text,
  p_event_type text,
  p_payment_id text,
  p_amount numeric,
  p_currency text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_inserted integer;
  v_applied text := 'IGNORED';
begin
  insert into webhook_events(event_id, provider, event_type, payment_id)
  values (p_event_id, 'GRAVV', p_event_type, p_payment_id)
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;

  select * into v_order
  from orders
  where payment_id = p_payment_id
  for update;

  if not found then
    raise exception 'No order matches payment %', p_payment_id;
  end if;

  if v_inserted = 0 then
    return jsonb_build_object(
      'orderId', v_order.id,
      'applied', 'DUPLICATE',
      'duplicate', true
    );
  end if;

  if v_order.currency <> upper(p_currency) then
    raise exception 'Payment currency does not match the order';
  end if;
  if v_order.deposit_amount <> round(p_amount, 2) then
    raise exception 'Payment amount does not match the expected deposit';
  end if;

  if p_event_type = 'payment.succeeded' then
    if v_order.deposit_status = 'PAID' then
      v_applied := 'ALREADY_PAID';
    elsif v_order.status <> 'DEPOSIT_PENDING' then
      raise exception 'Order is not waiting for a deposit';
    else
      update orders
      set status = 'DEPOSIT_PAID', deposit_status = 'PAID', version = version + 1
      where id = v_order.id
      returning * into v_order;
      v_applied := 'DEPOSIT_PAID';
    end if;
  elsif p_event_type in ('payment.failed', 'payment.expired') then
    if v_order.status = 'DEPOSIT_PENDING' and v_order.deposit_status <> 'PAID' then
      update orders
      set deposit_status = case
          when p_event_type = 'payment.expired' then 'EXPIRED'::deposit_status
          else 'FAILED'::deposit_status
        end,
        version = version + 1
      where id = v_order.id
      returning * into v_order;
      v_applied := case
        when p_event_type = 'payment.expired' then 'DEPOSIT_EXPIRED'
        else 'DEPOSIT_FAILED'
      end;
    end if;
  else
    raise exception 'Unsupported payment event type';
  end if;

  update webhook_events set processed_at = now() where event_id = p_event_id;
  return jsonb_build_object(
    'orderId', v_order.id,
    'applied', v_applied,
    'duplicate', false
  );
end;
$$;

revoke all on function process_gravv_webhook(text, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function process_gravv_webhook(text, text, text, numeric, text)
  to service_role;

-- Chat webhook replay ledger. Mirrored in db/migrations/20260811_p1_hardening.sql.
--   fresh     — p_sent_at is within the accepted clock-skew window
--   duplicate — this event_id was already recorded (a replay)
create or replace function record_chat_webhook_event(
  p_event_id text,
  p_sent_at timestamptz,
  p_max_skew_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  if abs(extract(epoch from (now() - p_sent_at))) > p_max_skew_seconds then
    return jsonb_build_object('fresh', false, 'duplicate', false);
  end if;

  insert into webhook_events(event_id, provider, event_type, payment_id)
  values (p_event_id, 'CHAT', 'chat.order', null)
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('fresh', true, 'duplicate', v_inserted = 0);
end;
$$;

revoke all on function record_chat_webhook_event(text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function record_chat_webhook_event(text, timestamptz, integer)
  to service_role;

-- Releases a chat event id so a failed order creation can be retried.
create or replace function release_chat_webhook_event(p_event_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from webhook_events where event_id = p_event_id and provider = 'CHAT';
$$;

revoke all on function release_chat_webhook_event(text)
  from public, anon, authenticated;
grant execute on function release_chat_webhook_event(text) to service_role;

-- Seller dashboard KPIs. Aggregated in SQL rather than folded in the API so
-- the numbers stay correct past PostgREST's row limit.
create or replace function seller_kpis(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      o.outcome,
      o.total_price,
      o.deposit_amount,
      coalesce(nullif(btrim(c.zone), ''), 'UNKNOWN') as zone
    from orders o
    left join customers c on c.id = o.customer_id
    where o.seller_id = p_seller_id
  ),
  totals as (
    select
      count(*)::int as total_orders,
      count(*) filter (where outcome = 'ACCEPTED')::int as accepted_orders,
      count(*) filter (where outcome = 'REFUSED')::int as refused_orders,
      round(
        coalesce(sum(total_price) filter (where outcome = 'ACCEPTED'), 0), 2
      ) as saved,
      round(
        coalesce(sum(deposit_amount) filter (where outcome = 'REFUSED'), 0), 2
      ) as fees
    from scoped
  ),
  zone_stats as (
    select
      zone,
      -- Refusal rate is measured over settled orders only; counting orders
      -- still in flight would make every zone look safer than it is.
      count(*) filter (where outcome <> 'PENDING')::int as settled_orders,
      count(*) filter (where outcome = 'REFUSED')::int as refused_orders
    from scoped
    group by zone
  )
  select jsonb_build_object(
    'sellerId', p_seller_id,
    'totalOrders', t.total_orders,
    'acceptedOrders', t.accepted_orders,
    'refusedOrders', t.refused_orders,
    'savedFromAcceptedOrders', t.saved,
    'feesCoveredByDeposits', t.fees,
    'refusalByZone', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'zone', z.zone,
                   'settledOrders', z.settled_orders,
                   'refusedOrders', z.refused_orders,
                   'refusalRate',
                     round(z.refused_orders::numeric / z.settled_orders, 3)
                 )
                 order by
                   z.refused_orders::numeric / z.settled_orders desc,
                   z.zone
               )
        from zone_stats z
        where z.settled_orders > 0
      ),
      '[]'::jsonb
    )
  )
  from totals t;
$$;

revoke all on function seller_kpis(uuid) from public, anon, authenticated;
grant execute on function seller_kpis(uuid) to service_role;

alter table customers enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table fitting_sessions enable row level security;
alter table webhook_events enable row level security;

-- ─────────────────────────────────────────────────────────────
-- The backend connects with the service-role key and bypasses RLS. No direct
-- anon/authenticated table policies are defined: all client access must pass
-- through the seller-authorising NestJS API.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- Schema self-check (read-only). Lets `npm run db:verify` confirm a deployed
-- database across tables, indexes, constraints, functions, grants, RLS and
-- triggers over PostgREST RPC. Definition mirrored in
-- db/migrations/20260810_verify_schema_fn.sql.
-- ─────────────────────────────────────────────────────────────

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
