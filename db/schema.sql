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
    'DEPOSIT_PAID', 'SHIPPED', 'ACCEPTED', 'REFUSED'
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
  phone             text not null unique,
  name              text,
  zone              text,
  total_orders      integer not null default 0,
  successful_orders integer not null default 0,
  refused_orders    integer not null default 0,
  risk_tier         risk_tier not null default 'MEDIUM',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_customers_phone on customers (phone);

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
create index if not exists idx_products_seller on products (seller_id);

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
  risk_score     integer check (risk_score between 0 and 100),
  deposit_rate   numeric(4,3) check (deposit_rate between 0 and 1),
  deposit_amount numeric(12,2),
  deposit_status deposit_status not null default 'NONE',
  payment_id     text,
  payment_url    text,
  outcome        order_outcome not null default 'PENDING',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_orders_seller on orders (seller_id);
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

-- ─────────────────────────────────────────────────────────────
-- Note: the backend connects with the service-role key and bypasses RLS.
-- If you expose any table to the anon/authenticated roles directly, enable
-- RLS and add policies scoped by seller_id.
-- ─────────────────────────────────────────────────────────────
