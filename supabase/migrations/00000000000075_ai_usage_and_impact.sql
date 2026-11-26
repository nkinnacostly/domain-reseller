-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 75: AI phase 4 — what the AI features cost, a monthly budget that
-- raises an alert, and whether the features are working (docs: "Making AI the
-- core of MyDomainsHub", phase 4).
--
-- (a) ai_model_rates: DeepSeek's listed prices per 1M tokens, off-peak, with
--     the peak multiplier and hours, from DeepSeek's pricing page. Cost
--     inputs live in a table, like every other price (N5b).
-- (b) ai_usage: one row per hour, feature and model — calls, calls with no
--     usable answer, answers that could not help, and token counts. Counts
--     only: never a prompt, an answer or a name (N13, FR-S7). Written only
--     through record_ai_usage, by the web and the gateway.
-- (c) ai_spend_micro: the estimated cost of a window, in micro-dollars.
-- (d) ops_settings.ai_budget_cents, changed through admin_update_ops_settings,
--     and an `ai_budget` alert once this month's estimate passes it.
-- (e) cart_items / order_items.added_via: whether a name was put in the cart
--     from the name finder or from a link an AI assistant made, so the AI page
--     can count what each one sold. A hint for counting only — nothing reads
--     it to price, check or register anything.
-- (f) admin_ai_report: the AI page's numbers, behind the admin read gate.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── (a) Rates ───────────────────────────────────────────────────────────────
create table public.ai_model_rates (
  model              text primary key check (char_length(model) between 1 and 60),
  -- US dollars per 1M tokens at the off-peak price.
  cached_usd_per_m   numeric(12, 4) not null check (cached_usd_per_m >= 0),
  uncached_usd_per_m numeric(12, 4) not null check (uncached_usd_per_m >= 0),
  output_usd_per_m   numeric(12, 4) not null check (output_usd_per_m >= 0),
  -- Peak price over off-peak, and the peak hours: UTC hours a call may start
  -- in, on weekdays only when peak_weekdays_only.
  peak_multiplier    numeric(6, 2) not null default 2 check (peak_multiplier >= 1),
  peak_hours_utc     smallint[] not null default '{}'
                       check (peak_hours_utc <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]::smallint[]),
  peak_weekdays_only boolean not null default true,
  source             text not null check (source ~ '^https://'),
  checked_on         date not null,
  updated_at         timestamptz not null default now()
);

alter table public.ai_model_rates enable row level security;
revoke all on public.ai_model_rates from public, anon, authenticated, service_role;
grant select on public.ai_model_rates to service_role;

-- api-docs.deepseek.com/quick_start/pricing, read 26 Nov 2026: off-peak is
-- half of peak; peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday.
-- Chinese public holidays are off-peak there and peak here, so on those days
-- the estimate runs high, never low.
insert into public.ai_model_rates
  (model, cached_usd_per_m, uncached_usd_per_m, output_usd_per_m, peak_multiplier,
   peak_hours_utc, peak_weekdays_only, source, checked_on)
values
  ('deepseek-flash', 0.003, 0.15, 0.60, 2, '{1,2,3,6,7,8,9}', true,
   'https://api-docs.deepseek.com/quick_start/pricing', date '2026-11-26'),
  ('deepseek-v4-pro', 0.022, 0.66, 1.98, 2, '{1,2,3,6,7,8,9}', true,
   'https://api-docs.deepseek.com/quick_start/pricing', date '2026-11-26');

-- ── (b) Usage ───────────────────────────────────────────────────────────────
create table public.ai_usage (
  hour              timestamptz not null
                      check (extract(minute from hour) = 0 and extract(second from hour) = 0),
  feature           text not null check (feature in (
                      'name_finder', 'name_ideas_overnight', 'setup_help', 'help_answer',
                      'alert_help', 'portfolio_copilot', 'order_screening')),
  model             text not null references public.ai_model_rates (model) on delete restrict,
  calls             integer not null default 0 check (calls >= 0),
  -- No usable answer: a timeout, a refusal, or an answer that did not parse.
  failed            integer not null default 0 check (failed between 0 and calls),
  -- Answered, but could not help: a help question the pages do not cover, a
  -- copilot instruction it could not turn into a change.
  declined          integer not null default 0 check (declined between 0 and calls - failed),
  prompt_tokens     bigint not null default 0 check (prompt_tokens >= 0),
  cached_tokens     bigint not null default 0 check (cached_tokens between 0 and prompt_tokens),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  primary key (hour, feature, model)
);

alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from public, anon, authenticated, service_role;
grant select on public.ai_usage to service_role;

-- One call, counted in this hour's row. Tokens are what DeepSeek reported, or
-- zero when it reported none (a timeout bills nothing we can see).
create function public.record_ai_usage(p_feature text, p_model text, p_outcome text,
                                       p_prompt_tokens integer, p_cached_tokens integer,
                                       p_completion_tokens integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_prompt     bigint := coalesce(p_prompt_tokens, 0);
  v_cached     bigint := coalesce(p_cached_tokens, 0);
  v_completion bigint := coalesce(p_completion_tokens, 0);
begin
  if coalesce(p_outcome, '') not in ('ok', 'failed', 'declined') then
    raise exception 'record_ai_usage: outcome is ok, failed or declined' using errcode = '22023';
  end if;
  if v_prompt not between 0 and 10000000 or v_cached not between 0 and v_prompt
     or v_completion not between 0 and 10000000 then
    raise exception 'record_ai_usage: token counts out of range' using errcode = '22023';
  end if;
  insert into public.ai_usage as u (hour, feature, model, calls, failed, declined,
                                    prompt_tokens, cached_tokens, completion_tokens)
  values (date_trunc('hour', now(), 'UTC'), p_feature, p_model, 1,
          (p_outcome = 'failed')::integer, (p_outcome = 'declined')::integer,
          v_prompt, v_cached, v_completion)
  on conflict (hour, feature, model) do update
     set calls = u.calls + 1,
         failed = u.failed + excluded.failed,
         declined = u.declined + excluded.declined,
         prompt_tokens = u.prompt_tokens + excluded.prompt_tokens,
         cached_tokens = u.cached_tokens + excluded.cached_tokens,
         completion_tokens = u.completion_tokens + excluded.completion_tokens;
end $$;

-- ── (c) Spend ───────────────────────────────────────────────────────────────
-- One row's estimated cost in micro-dollars: tokens × dollars per 1M tokens
-- is micro-dollars exactly; peak hours cost the multiplier more. Rounded up.
create function public.ai_usage_cost_micro(p_usage public.ai_usage)
returns bigint language sql stable security definer set search_path = '' as $$
  select ceil(
           ((p_usage.cached_tokens * r.cached_usd_per_m)
            + ((p_usage.prompt_tokens - p_usage.cached_tokens) * r.uncached_usd_per_m)
            + (p_usage.completion_tokens * r.output_usd_per_m))
           * case when extract(hour from p_usage.hour at time zone 'UTC')::smallint = any (r.peak_hours_utc)
                   and (not r.peak_weekdays_only
                        or extract(isodow from p_usage.hour at time zone 'UTC') between 1 and 5)
                  then r.peak_multiplier else 1 end)::bigint
    from public.ai_model_rates r
   where r.model = p_usage.model $$;

create function public.ai_spend_micro(p_from timestamptz, p_to timestamptz)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(public.ai_usage_cost_micro(u)), 0)::bigint
    from public.ai_usage u
   where u.hour >= date_trunc('hour', p_from, 'UTC') and u.hour < p_to $$;

-- ── (d) The budget ──────────────────────────────────────────────────────────
alter table public.ops_settings
  add column ai_budget_cents integer not null default 5000
    check (ai_budget_cents between 100 and 1000000);
comment on column public.ops_settings.ai_budget_cents is
  'AI phase 4: an ai_budget alert is raised once this month''s estimated AI spend (WAT months) passes this, in US cents.';

alter table public.cart_items
  add column added_via text check (added_via in ('name_finder', 'assistant_link'));
alter table public.order_items
  add column added_via text check (added_via in ('name_finder', 'assistant_link'));
comment on column public.order_items.added_via is
  'Migration 75: copied from the cart line — put in the cart from the name finder, or from a link an AI assistant made. Counted on the AI page; read by nothing else.';

-- As migration 10's (39's), carrying added_via with each line.
CREATE OR REPLACE FUNCTION public.merge_anonymous_cart(p_token_hash text, p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_anon  uuid;
  v_user  uuid;
  v_moved integer := 0;
  v_ssl   integer := 0;
begin
  select id into v_anon
    from public.carts
   where anon_token_hash = p_token_hash
     for update;
  if v_anon is null then
    return 0;
  end if;

  -- A session can outlive its account for a few minutes; keep the cart.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return 0;
  end if;

  insert into public.carts (user_id) values (p_user_id)
    on conflict (user_id) do nothing;
  select id into v_user from public.carts where user_id = p_user_id;

  -- A domain already in the user's cart keeps the user's line and quote.
  insert into public.cart_items (
    cart_id, domain, tld, period_years, privacy, auto_renew,
    quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at, added_via
  )
  select v_user, domain, tld, period_years, privacy, auto_renew,
         quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at, added_via
    from public.cart_items
   where cart_id = v_anon
  on conflict (cart_id, domain) do nothing;
  get diagnostics v_moved = row_count;

  -- So does a certificate for a name already there.
  insert into public.cart_ssl_items (
    cart_id, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id, quoted_at
  )
  select v_user, product_code, common_name, quoted_total_kobo, quoted_fx_rate_id, quoted_at
    from public.cart_ssl_items
   where cart_id = v_anon
  on conflict (cart_id, common_name) do nothing;
  get diagnostics v_ssl = row_count;

  delete from public.carts where id = v_anon;
  return v_moved + v_ssl;
end;
$function$;

-- As migration 40's, plus ai_budget_cents (US cents, $1 to $10,000).
CREATE OR REPLACE FUNCTION public.admin_update_ops_settings(p_changes jsonb, p_reason text, p_request_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_action text := 'settings.update';
  v_prior  jsonb;
  v_now    public.ops_settings;
  v_key    text;
  v_num    numeric;
  v_code   text;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
  v_single numeric;
  v_daily  numeric;
  v_new    numeric;
  v_trust  numeric;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, v_action, 'ops_settings');
  if v_prior is not null then return v_prior; end if;
  select * into v_now from public.ops_settings where id for update;
  v_code := coalesce(public.admin_gate(v_admin, v_action, false), public.admin_reason_problem(p_reason));
  if v_code is null and (p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb) then
    v_code := 'NO_CHANGES';
  end if;
  if v_code is null then
    for v_key in select jsonb_object_keys(p_changes) loop
      if v_key not in ('auto_refund_max_kobo', 'auto_refund_daily_max_kobo', 'refund_delay_minutes',
                       'stuck_order_minutes', 'max_domains_per_account_day', 'float_alert_cents',
                       'velocity_new_max', 'velocity_trusted_max', 'velocity_standard_after_days',
                       'velocity_trusted_after_days', 'velocity_trusted_after_paid_orders',
                       'ai_budget_cents') then
        v_code := 'UNKNOWN_KEY';
        exit;
      end if;
      v_num := public.admin_json_number(p_changes -> v_key, 0);
      if v_num is null
         or (v_key = 'auto_refund_max_kobo' and v_num not between 1 and 100000000)
         or (v_key = 'auto_refund_daily_max_kobo' and v_num not between 1 and 500000000)
         or (v_key = 'refund_delay_minutes' and v_num not between 5 and 1440)
         or (v_key = 'stuck_order_minutes' and v_num not between 5 and 1440)
         or (v_key = 'max_domains_per_account_day' and v_num not between 1 and 1000)
         or (v_key = 'float_alert_cents' and v_num not between 0 and 1000000)
         or (v_key = 'velocity_new_max' and v_num not between 1 and 1000)
         or (v_key = 'velocity_trusted_max' and v_num not between 1 and 5000)
         or (v_key = 'velocity_standard_after_days' and v_num not between 0 and 365)
         or (v_key = 'velocity_trusted_after_days' and v_num not between 0 and 3650)
         or (v_key = 'velocity_trusted_after_paid_orders' and v_num not between 0 and 1000)
         or (v_key = 'ai_budget_cents' and v_num not between 100 and 1000000) then
        v_code := 'OUT_OF_RANGE';
        exit;
      end if;
      v_before := v_before || jsonb_build_object(v_key, (case v_key
                    when 'float_alert_cents' then to_jsonb(round(v_now.float_alert_usd * 100)::bigint)
                    else to_jsonb(v_now) -> v_key end));
      v_after := v_after || jsonb_build_object(v_key, v_num);
    end loop;
  end if;
  if v_code is null then
    v_single := coalesce((v_after ->> 'auto_refund_max_kobo')::numeric, v_now.auto_refund_max_kobo);
    v_daily := coalesce((v_after ->> 'auto_refund_daily_max_kobo')::numeric, v_now.auto_refund_daily_max_kobo);
    v_new := coalesce((v_after ->> 'velocity_new_max')::numeric, v_now.velocity_new_max);
    v_trust := coalesce((v_after ->> 'velocity_trusted_max')::numeric, v_now.velocity_trusted_max);
    if v_daily < v_single or v_trust < v_new then
      v_code := 'OUT_OF_RANGE';
    end if;
  end if;
  if v_code is null
     and (coalesce((v_after ->> 'auto_refund_max_kobo')::numeric, v_now.auto_refund_max_kobo) > v_now.auto_refund_max_kobo
          or coalesce((v_after ->> 'auto_refund_daily_max_kobo')::numeric, v_now.auto_refund_daily_max_kobo) > v_now.auto_refund_daily_max_kobo
          or coalesce((v_after ->> 'refund_delay_minutes')::numeric, v_now.refund_delay_minutes) < v_now.refund_delay_minutes) then
    v_action := 'settings.refund_limit_raise';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, v_action, 'global', 'ops_settings', 'ops_settings', null,
                               p_reason, p_request_key, 'refused', v_code, null,
                               jsonb_build_object('keys', (select coalesce(jsonb_agg(k), '[]'::jsonb)
                                                             from jsonb_object_keys(case when jsonb_typeof(p_changes) = 'object'
                                                                                         then p_changes else '{}'::jsonb end) k)));
  end if;
  update public.ops_settings
     set auto_refund_max_kobo = coalesce((v_after ->> 'auto_refund_max_kobo')::bigint, auto_refund_max_kobo),
         auto_refund_daily_max_kobo = coalesce((v_after ->> 'auto_refund_daily_max_kobo')::bigint, auto_refund_daily_max_kobo),
         refund_delay_minutes = coalesce((v_after ->> 'refund_delay_minutes')::integer, refund_delay_minutes),
         stuck_order_minutes = coalesce((v_after ->> 'stuck_order_minutes')::integer, stuck_order_minutes),
         max_domains_per_account_day = coalesce((v_after ->> 'max_domains_per_account_day')::integer, max_domains_per_account_day),
         float_alert_usd = coalesce((v_after ->> 'float_alert_cents')::numeric / 100, float_alert_usd),
         velocity_new_max = coalesce((v_after ->> 'velocity_new_max')::integer, velocity_new_max),
         velocity_trusted_max = coalesce((v_after ->> 'velocity_trusted_max')::integer, velocity_trusted_max),
         velocity_standard_after_days = coalesce((v_after ->> 'velocity_standard_after_days')::integer, velocity_standard_after_days),
         velocity_trusted_after_days = coalesce((v_after ->> 'velocity_trusted_after_days')::integer, velocity_trusted_after_days),
         velocity_trusted_after_paid_orders = coalesce((v_after ->> 'velocity_trusted_after_paid_orders')::integer, velocity_trusted_after_paid_orders),
         ai_budget_cents = coalesce((v_after ->> 'ai_budget_cents')::integer, ai_budget_cents)
   where id;
  return public.admin_record(v_admin, v_action, 'global', 'ops_settings', 'ops_settings', null,
    p_reason, p_request_key, 'ok', null, null, jsonb_build_object('before', v_before, 'after', v_after));
end $function$;

-- As migration 73's, plus the AI budget.
CREATE OR REPLACE FUNCTION public.admin_alert_conditions(p_test_mode boolean)
 RETURNS TABLE(key text, severity text, kind text, summary text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Any change that touches a non-test admin, before or after, and any test
  -- admin written for someone who is not an e2e user. Removing an e2e test
  -- admin (teardown, a cascade from auth.users) is the one quiet change.
  select 'admin_changed:' || c.id, 'critical', 'admin_changed',
         format('Admin access changed in the database: %s of %s (%s%s, %s linked devices%s) by %s. If you did not do this, revoke it now (DEPLOY.md §6b).',
                lower(c.op), c.label, coalesce(c.role, 'no role'),
                case when c.test_only then ', test only' else '' end, coalesce(c.factor_count, 0),
                case when c.revoked then ', revoked' else '' end, c.db_user)
    from public.admin_changes c
   where not p_test_mode and c.at > now() - interval '24 hours'
     and (not c.test_only or c.was_test_only is false or (c.op <> 'DELETE' and not c.e2e_user))

  union all
  -- A standing test admin whose user is not an e2e-*@example.com address: a
  -- real person with test access sees test-side contacts (D15).
  select 'admin_test_not_e2e:' || a.label, 'critical', 'admin_test_not_e2e',
         format('Test admin %s belongs to an account that is not an e2e test user. Revoke it unless you meant this (DEPLOY.md §6b).',
                a.label)
    from public.admins a
    left join auth.users u on u.id = a.user_id
   where not p_test_mode and a.test_only and a.revoked_at is null
     and not public.admin_e2e_email(u.email)

  union all
  select 'admin_factor_missing:' || a.label,
         case when v.still = 0 then 'critical' else 'warning' end,
         'admin_factor_missing',
         format('Admin %s: %s of %s linked authenticators are no longer verified — re-link the devices (DEPLOY.md §6b)',
                a.label, cardinality(a.mfa_factor_ids) - v.still, cardinality(a.mfa_factor_ids))
    from public.admins a
    cross join lateral (
      select count(*)::integer as still from auth.mfa_factors f
       where f.id = any (a.mfa_factor_ids) and f.user_id = a.user_id
         and f.status = 'verified' and f.factor_type = 'totp') v
   where not p_test_mode and a.revoked_at is null and not a.test_only
     and v.still < cardinality(a.mfa_factor_ids)

  union all
  select 'admin_burst:' || l.admin_label, 'warning', 'admin_burst',
         format('Admin %s looked up %s customers or registrants in the last hour', l.admin_label, count(*))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action in ('customer.search', 'customer.reveal', 'domain.reveal_contacts')
     and l.created_at > now() - interval '1 hour'
   group by l.admin_label
  having count(*) >= 20

  union all
  select 'admin_limit_raised:' || l.id, 'warning', 'admin_limit_raised',
         format('Admin %s raised a refund limit or shortened the refund delay: %s',
                l.admin_label, left(coalesce((l.detail -> 'after')::text, ''), 200))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action = 'settings.refund_limit_raise' and l.outcome = 'ok'
     and l.created_at > now() - interval '24 hours'

  union all
  select 'admin_preset_changed:' || l.id, 'warning', 'admin_preset_changed',
         format('Admin %s: %s for %s — nameservers %s → %s',
                l.admin_label, replace(l.action, 'preset.', 'preset '), coalesce(l.detail ->> 'provider', 'a preset'),
                coalesce(array_to_string(array(select jsonb_array_elements_text(
                  case when jsonb_typeof(l.detail #> '{before,nameservers}') = 'array'
                       then l.detail #> '{before,nameservers}' else '[]'::jsonb end)), ', '), 'none'),
                coalesce(array_to_string(array(select jsonb_array_elements_text(
                  case when jsonb_typeof(l.detail #> '{after,nameservers}') = 'array'
                       then l.detail #> '{after,nameservers}' else '[]'::jsonb end)), ', '), 'none'))
    from public.admin_audit_log l
   where not p_test_mode and not l.test_actor
     and l.action in ('preset.draft_save', 'preset.publish', 'preset.show', 'preset.hide') and l.outcome = 'ok'
     and l.created_at > now() - interval '24 hours'

  union all
  -- Migration 73: an order line screening found phishing-shaped, not yet
  -- reviewed by a person. The order is never held for it.
  select 'order_screening:' || s.order_item_id, 'warning', 'order_screening_review',
         format('A new order for %s looks like it may imitate %s — review it (nothing was held): %s',
                s.domain, coalesce(array_to_string(s.matched, ', '), 'a brand or a sign-in page'),
                coalesce(s.note, 'flagged by the word list'))
    from public.order_screenings s
   where s.test_mode = p_test_mode and s.verdict = 'review' and s.reviewed_at is null

  union all
  -- Migration 75: this month's AI spend, estimated from the token counts
  -- (ai_usage) at DeepSeek's listed prices (ai_model_rates), past the budget
  -- in Settings. Not a side's: one DeepSeek account serves both.
  select 'ai_budget:' || to_char(b.month_start at time zone 'Africa/Lagos', 'YYYY-MM'),
         case when b.spend_micro >= 2 * b.budget_cents * 10000 then 'critical' else 'warning' end,
         'ai_budget',
         format('AI spend this month is about %s, past the %s budget — an estimate from token counts at DeepSeek''s listed prices. See which feature is spending on the AI page, or raise the budget in Settings.',
                '$' || to_char(b.spend_micro / 1000000.0, 'FM999999990.00'),
                '$' || to_char(b.budget_cents / 100.0, 'FM999999990.00'))
    from (
      select m.month_start, s.ai_budget_cents::bigint as budget_cents,
             public.ai_spend_micro(m.month_start, now()) as spend_micro
        from (select (date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as month_start) m
        cross join public.ops_settings s
       where s.id
    ) b
   where not p_test_mode and b.spend_micro > b.budget_cents * 10000
$function$;

-- ── (f) The AI page ─────────────────────────────────────────────────────────
-- Days are WAT, inclusive. Spend and usage belong to no side (one DeepSeek
-- account serves both), so a test administrator gets them as null, like the
-- limits. The rest is the side's own:
--   lines       paid new-domain lines in the window, and how many of them were
--               put in the cart from the name finder or an assistant's link;
--   delegation  domains registered in the window at least 7 days ago, and how
--               many were pointed and verified within 7 days (target 60%);
--   screening   lines screened in the window, flagged, and flagged ones still
--               waiting for a person;
--   bulk        accounts holding 10 or more domains, and their bulk changes in
--               the window and in the same number of days before it.
create function public.admin_ai_report(p_test_mode boolean, p_from date, p_to date)
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
               'assistantLink', count(*) filter (where i.added_via = 'assistant_link'))
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

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.record_ai_usage(text, text, text, integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_usage_cost_micro(public.ai_usage) from public, anon, authenticated, service_role;
revoke all on function public.ai_spend_micro(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_ai_report(boolean, date, date) from public, anon, authenticated, service_role;
grant execute on function public.record_ai_usage(text, text, text, integer, integer, integer) to service_role;
grant execute on function public.admin_ai_report(boolean, date, date) to authenticated;

notify pgrst, 'reload schema';
