-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 76 — AI phase 5: one assistant on every page
--
-- The site assistant (docs: "Making AI the core of MyDomainsHub", phase 5)
-- reads what a person asks and hands it to the engine that answers it: the
-- name finder, an availability check, the price tables, the nameserver
-- presets or the help centre. It is measured like the earlier phases:
--
-- (a) ai_usage.feature also takes 'site_assistant', the routing call; the
--     name ideas it asks for are counted as 'name_finder', as on /ideas.
-- (b) cart_items / order_items.added_via also take 'site_assistant': a name
--     put in the cart from one of the assistant's answers.
-- (c) admin_ai_report's lines count those as siteAssistant, beside the name
--     finder's and the assistant links'.
--
-- Nothing else changes: no new table, no new grant, no new way to write.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── (a) Usage ───────────────────────────────────────────────────────────────
alter table public.ai_usage drop constraint ai_usage_feature_check;
alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (
  'name_finder', 'name_ideas_overnight', 'setup_help', 'help_answer',
  'alert_help', 'portfolio_copilot', 'order_screening', 'site_assistant'));

-- ── (b) Where a cart line came from ─────────────────────────────────────────
alter table public.cart_items drop constraint cart_items_added_via_check;
alter table public.cart_items add constraint cart_items_added_via_check
  check (added_via in ('name_finder', 'assistant_link', 'site_assistant'));
alter table public.order_items drop constraint order_items_added_via_check;
alter table public.order_items add constraint order_items_added_via_check
  check (added_via in ('name_finder', 'assistant_link', 'site_assistant'));
comment on column public.order_items.added_via is
  'Migrations 75–76: copied from the cart line — put in the cart from the name finder, from a link an AI assistant made, or from the site assistant. Counted on the AI page; read by nothing else.';

-- ── (c) The AI page ─────────────────────────────────────────────────────────
-- As migration 75's, with siteAssistant among the lines.
create or replace function public.admin_ai_report(p_test_mode boolean, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_read_gate(p_test_mode);
  v_from  timestamptz := (p_from::timestamp at time zone 'Africa/Lagos');
  v_to    timestamptz := ((p_to + 1)::timestamp at time zone 'Africa/Lagos');
  v_days  integer := p_to - p_from + 1;
  v_month timestamptz := (date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos');
  v_spend jsonb := null;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'admin:bad_range';
  end if;

  if not v_admin.test_only then
    v_spend := jsonb_build_object(
      'monthMicro', public.ai_spend_micro(v_month, now()),
      'budgetCents', (select s.ai_budget_cents from public.ops_settings s where s.id),
      'since', (select min(u.hour) from public.ai_usage u),
      'features', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'feature', f.feature, 'calls', f.calls, 'failed', f.failed, 'declined', f.declined,
                 'promptTokens', f.prompt_tokens, 'cachedTokens', f.cached_tokens,
                 'completionTokens', f.completion_tokens, 'costMicro', f.cost_micro)
                 order by f.cost_micro desc, f.feature), '[]'::jsonb)
          from (select u.feature, sum(u.calls)::bigint as calls, sum(u.failed)::bigint as failed,
                       sum(u.declined)::bigint as declined, sum(u.prompt_tokens)::bigint as prompt_tokens,
                       sum(u.cached_tokens)::bigint as cached_tokens,
                       sum(u.completion_tokens)::bigint as completion_tokens,
                       sum(public.ai_usage_cost_micro(u))::bigint as cost_micro
                  from public.ai_usage u
                 where u.hour >= v_from and u.hour < v_to
                 group by u.feature) f),
      'daily', (
        select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'costMicro', d.cost_micro)
                                  order by d.day), '[]'::jsonb)
          from (select (u.hour at time zone 'Africa/Lagos')::date as day,
                       sum(public.ai_usage_cost_micro(u))::bigint as cost_micro
                  from public.ai_usage u
                 where u.hour >= v_from and u.hour < v_to
                 group by 1) d));
  end if;

  return jsonb_build_object(
    'spend', v_spend,
    'lines', (
      select jsonb_build_object(
               'paid', count(*),
               'nameFinder', count(*) filter (where i.added_via = 'name_finder'),
               'assistantLink', count(*) filter (where i.added_via = 'assistant_link'),
               'siteAssistant', count(*) filter (where i.added_via = 'site_assistant'))
        from public.order_items i
        join public.orders o on o.id = i.order_id
       where o.test_mode = p_test_mode
         and o.paid_at >= v_from and o.paid_at < v_to
         and i.item_type = 'register'),
    'delegation', (
      select jsonb_build_object(
               'registered', count(*),
               'verifiedIn7', count(*) filter (where exists (
                 select 1 from public.domain_events e
                  where e.domain_id = d.id and e.event_type = 'delegation_verified'
                    and e.created_at <= d.registered_at + interval '7 days')))
        from public.domains d
       where d.test_mode = p_test_mode and d.source <> 'demo'
         and d.registered_at >= v_from and d.registered_at < v_to
         and d.registered_at <= now() - interval '7 days'),
    'screening', (
      select jsonb_build_object(
               'screened', count(*),
               'flagged', count(*) filter (where s.verdict = 'review'),
               'waiting', count(*) filter (where s.verdict = 'review' and s.reviewed_at is null))
        from public.order_screenings s
       where s.test_mode = p_test_mode and s.screened_at >= v_from and s.screened_at < v_to),
    'bulk', (
      with agencies as (
        select d.user_id
          from public.domains d
         where d.test_mode = p_test_mode and d.source <> 'demo'
           and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_verification')
         group by d.user_id
        having count(*) >= 10
      )
      select jsonb_build_object(
               'agencies', (select count(*) from agencies),
               'current', count(*) filter (where b.created_at >= v_from and b.created_at < v_to),
               'prior', count(*) filter (where b.created_at >= v_from - make_interval(days => v_days)
                                           and b.created_at < v_from))
        from public.bulk_operations b
       where b.user_id in (select a.user_id from agencies a)
         and b.created_at >= v_from - make_interval(days => v_days) and b.created_at < v_to));
end;
$$;

revoke all on function public.admin_ai_report(boolean, date, date) from public, anon, authenticated, service_role;
grant execute on function public.admin_ai_report(boolean, date, date) to authenticated;

notify pgrst, 'reload schema';
