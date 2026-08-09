-- CODLOCK backend hardening migration.
-- Apply once to databases created from the original schema.

alter type order_status add value if not exists 'READY_TO_SHIP' after 'DEPOSIT_PAID';

-- Seller ownership cannot be guessed safely for customers that predate this
-- migration, so the migration refuses rather than inventing an owner.
--
-- This first guard runs BEFORE the column is added, and that ordering is
-- deliberate. The whole file executes as one transaction (the Supabase SQL
-- editor wraps it), so a later `raise exception` rolls back the ADD COLUMN
-- too — leaving an operator told to "backfill customers.seller_id" against a
-- column that no longer exists. Detecting the legacy shape up front lets the
-- error name a remediation that actually works.
do $$
begin
  if exists (select 1 from customers)
     and not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'customers'
          and column_name = 'seller_id'
     )
  then
    raise exception 'customers has rows but no seller_id column'
      using hint =
        'Run "alter table customers add column seller_id uuid;", set every '
        'row to its owning seller, then re-run this migration. A disposable '
        'development database can be recreated from db/schema.sql instead.';
  end if;
end $$;

alter table customers add column if not exists seller_id uuid;

-- The column exists from here on, so this instruction is actionable.
do $$
begin
  if exists (select 1 from customers where seller_id is null) then
    raise exception
      'Backfill customers.seller_id before applying CODLOCK hardening';
  end if;
end $$;

alter table customers alter column seller_id set not null;
alter table customers drop constraint if exists customers_phone_key;
drop index if exists idx_customers_phone;
create unique index if not exists idx_customers_seller_phone
  on customers (seller_id, phone);

alter table orders add column if not exists currency text not null default 'TND';
alter table orders add column if not exists version integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_currency_length'
  ) then
    alter table orders add constraint orders_currency_length
      check (char_length(currency) = 3);
  end if;
end $$;

create table if not exists webhook_events (
  event_id      text primary key,
  provider      text not null,
  event_type    text not null,
  payment_id    text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists idx_webhook_events_payment
  on webhook_events (payment_id);

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
      successful_orders = successful_orders
        + case when p_outcome = 'ACCEPTED' then 1 else 0 end,
      refused_orders = refused_orders
        + case when p_outcome = 'REFUSED' then 1 else 0 end,
      risk_tier = case
        when (refused_orders
              + case when p_outcome = 'REFUSED' then 1 else 0 end)::numeric
             / (total_orders + 1) >= 0.4 then 'HIGH'::risk_tier
        when (refused_orders
              + case when p_outcome = 'REFUSED' then 1 else 0 end)::numeric
             / (total_orders + 1) <= 0.1
             and total_orders + 1 >= 3 then 'TRUSTED'::risk_tier
        else 'MEDIUM'::risk_tier
      end
  where id = v_order.customer_id and seller_id = p_seller_id;

  if not found then
    raise exception 'Customer not found for seller';
  end if;

  return to_jsonb(v_order);
end;
$$;

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
      set status = 'DEPOSIT_PAID',
          deposit_status = 'PAID',
          version = version + 1
      where id = v_order.id
      returning * into v_order;
      v_applied := 'DEPOSIT_PAID';
    end if;
  elsif p_event_type in ('payment.failed', 'payment.expired') then
    if v_order.status = 'DEPOSIT_PENDING'
       and v_order.deposit_status <> 'PAID' then
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

revoke all on function record_order_outcome(uuid, uuid, order_outcome)
  from public, anon, authenticated;
grant execute on function record_order_outcome(uuid, uuid, order_outcome)
  to service_role;
revoke all on function process_gravv_webhook(text, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function process_gravv_webhook(text, text, text, numeric, text)
  to service_role;

alter table customers enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table fitting_sessions enable row level security;
alter table webhook_events enable row level security;
