-- CODLOCK P1 hardening.
-- Apply after the 20260809/20260810 migrations. Additive and idempotent.

-- ── Chat webhook replay ledger ───────────────────────────────
-- webhook_events becomes the shared idempotency ledger for both Gravv and the
-- social chat webhook. Chat events have no payment, so payment_id is relaxed
-- to nullable. (Gravv still always inserts a payment_id — never affected.)
alter table webhook_events alter column payment_id drop not null;

-- Records a chat webhook event for replay protection.
--   fresh     — p_sent_at is within the accepted clock-skew window
--   duplicate — this event_id was already recorded (a replay)
-- A stale event is never recorded, so a later legitimate resend still works.
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

-- ── Order cancellation (P1 #5) ───────────────────────────────
-- A terminal state for orders abandoned before fulfilment. The application
-- state machine (src/common/enums/order-status.enum.ts) restricts which states
-- may reach it; the enum only needs the value to exist.
alter type order_status add value if not exists 'CANCELLED';
