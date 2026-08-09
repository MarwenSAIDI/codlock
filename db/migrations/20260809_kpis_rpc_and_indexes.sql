-- CODLOCK — seller KPI aggregation + list-query indexes.
-- Apply after 20260809_backend_hardening.sql.
--
-- Replaces the in-memory KPI fold in AnalyticsService, which fetched every
-- order for a seller and was therefore silently truncated by PostgREST's row
-- limit once a seller passed ~1000 orders.

-- Backs the paginated, newest-first order list.
create index if not exists idx_orders_seller_created
  on orders (seller_id, created_at desc);
-- Backs the paginated, recently-updated-first catalog and customer lists.
create index if not exists idx_products_seller_updated
  on products (seller_id, updated_at desc);
create index if not exists idx_customers_seller_updated
  on customers (seller_id, updated_at desc);

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
      -- Refusal rate is measured over settled orders only. Including orders
      -- still in flight would make every zone look safer than it is, and the
      -- rate would drift as unresolved orders accumulate.
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
