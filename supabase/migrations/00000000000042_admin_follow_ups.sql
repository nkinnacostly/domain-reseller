-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 42: what the B packages needed from SQL (docs/ADMIN-SPEC.md §9:
-- "a B package that needs SQL or a shared change raises a follow-up for A").
--
--   1. admin_overview: paid lines counted over 7 and 90 days as well as 30,
--      so B1's period picker drives the registration, renewal, transfer and
--      SSL tiles too.
--   2. admin_customers: `p_filter.userIds`, so B2 looks a page's buyers up by
--      id instead of paging through every profile.
--   3. admin_stuck_order_minutes(): the stuck-order threshold alone, so B2's
--      "Stuck only" is exact for a test admin too; ops_settings itself stays
--      refused to them (§2.3).
--   4. admin_pricing_status: the example extension's (.com) costs in whole
--      cents, so B12 reads no `*_usd` column (D24).
--   5. admin_job_ledger(p_test_mode, p_job_id): when the supplier ledger was
--      last read, and how many charges name the job's domain since the job
--      started — admin_fail_job's own LEDGER_SHOWS_CHARGE test, as a count,
--      for B4's Fail precondition panel.
--   6. admin_ssl_job_certificate(p_test_mode, p_job_id): a certificate job's
--      name and order line, and nothing else of the certificate, for B4.
--   7. admin_set_tld_flags: a featured rank another extension holds is a
--      recorded refusal (RANK_TAKEN), not a raised unique violation.
--
-- Every function here, new or re-created, is revoked from public, anon,
-- authenticated and service_role and granted to authenticated only (§3.0).
-- Reads start with the admin gate; those with a side refuse a test admin the
-- live side (admin_read_gate). Checked by supabase/tests/admin_42.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The overview counts lines over each period ───────────────────────────
-- As migration 41, except `lines`, which now holds d7, d30 and d90.

create or replace function public.admin_overview(p_test_mode boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_read_gate(p_test_mode);
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_out   jsonb;
  v_cron  jsonb;
begin
  v_out := jsonb_build_object(
    'sales', jsonb_build_object(
      'd1', public.admin_sales_since(p_test_mode, now() - interval '1 day'),
      'd7', public.admin_sales_since(p_test_mode, now() - interval '7 days'),
      'd30', public.admin_sales_since(p_test_mode, now() - interval '30 days'),
      'd90', public.admin_sales_since(p_test_mode, now() - interval '90 days')),
    -- Paid lines by kind over the same windows as `sales` (paid_at > now − N days).
    'lines', (select jsonb_object_agg(w.key, (
                select jsonb_build_object(
                         'register', count(*) filter (where oi.item_type = 'register'),
                         'renew', count(*) filter (where oi.item_type = 'renew'),
                         'transfer', count(*) filter (where oi.item_type = 'transfer'),
                         'ssl', count(*) filter (where oi.item_type = 'ssl'))
                  from public.order_items oi join public.orders o on o.id = oi.order_id
                 where o.test_mode = p_test_mode and o.payment_id is not null and o.paid_at > now() - w.span))
                from (values ('d7', interval '7 days'), ('d30', interval '30 days'), ('d90', interval '90 days'))
                     as w(key, span)),
    'float', public.float_runway(p_test_mode),
    'health', jsonb_build_object(
      'heartbeats', (select coalesce(jsonb_agg(jsonb_build_object('name', h.name, 'beatAt', h.beat_at,
                                                                  'outcome', h.detail ->> 'outcome') order by h.name), '[]'::jsonb)
                       from public.service_heartbeats h where h.test_mode = p_test_mode),
      'reconcile', (select jsonb_build_object('finishedAt', r.finished_at, 'error', left(r.error, 200))
                      from public.reconcile_runs r where r.test_mode = p_test_mode and r.finished_at is not null
                     order by r.finished_at desc limit 1),
      'fx', (select jsonb_build_object(
                      'activeFrom', a.effective_from, 'costingRate', a.costing_rate,
                      'pendingCount', (select count(*) from public.fx_rates p where p.status = 'pending_review'),
                      'pendingOldestAt', (select min(p.quoted_at) from public.fx_rates p where p.status = 'pending_review'))
               from (select 1) one
               left join lateral (select * from public.fx_rates f where f.status = 'active'
                                   order by f.effective_from desc nulls last limit 1) a on true),
      'snapshotAt', (select max(s.taken_at) from public.supplier_balance_snapshots s where s.test_mode = p_test_mode)),
    'signups7d', (select count(*) from public.profiles p
                   where public.is_reserved_email(p.email::text) = p_test_mode and p.created_at > now() - interval '7 days'),
    'expiries30d', (select count(*) from public.domains d
                     where d.test_mode = p_test_mode and d.source <> 'demo'
                       and d.local_status in ('active', 'expired_grace', 'redemption')
                       and d.expires_at between now() and now() + interval '30 days'),
    'revenueByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'netKobo', coalesce(s.net, 0)) order by g.day), '[]'::jsonb)
                       from generate_series((v_today - 29)::timestamp, v_today::timestamp, interval '1 day') as g(day)
                       left join (select (o.paid_at at time zone 'Africa/Lagos')::date as day, sum(o.subtotal_kobo) as net
                                    from public.orders o
                                   where o.test_mode = p_test_mode and o.payment_id is not null
                                     and o.paid_at > now() - interval '31 days'
                                   group by 1) s on s.day = g.day::date),
    'balanceByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day::date, 'closeCents', s.close) order by g.day), '[]'::jsonb)
                       from generate_series((v_today - 29)::timestamp, v_today::timestamp, interval '1 day') as g(day)
                       left join (select distinct on ((b.taken_at at time zone 'Africa/Lagos')::date)
                                         (b.taken_at at time zone 'Africa/Lagos')::date as day,
                                         round(b.balance_usd * 100)::bigint as close
                                    from public.supplier_balance_snapshots b
                                   where b.test_mode = p_test_mode and b.taken_at > now() - interval '31 days'
                                   order by (b.taken_at at time zone 'Africa/Lagos')::date, b.taken_at desc) s
                         on s.day = g.day::date),
    'renewalsByMonth', (select coalesce(jsonb_agg(jsonb_build_object('month', g.month::date, 'count', coalesce(s.n, 0)) order by g.month), '[]'::jsonb)
                          from generate_series(date_trunc('month', v_today::timestamp),
                                               date_trunc('month', v_today::timestamp) + interval '5 months',
                                               interval '1 month') as g(month)
                          left join (select date_trunc('month', (d.expires_at at time zone 'Africa/Lagos')) as month, count(*) as n
                                       from public.domains d
                                      where d.test_mode = p_test_mode and d.source <> 'demo'
                                        and d.local_status in ('active', 'expired_grace', 'redemption')
                                        and d.expires_at >= now() and d.expires_at < now() + interval '6 months'
                                      group by 1) s on s.month = g.month),
    'domainsByStatus', (select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n) order by s.n desc), '[]'::jsonb)
                          from (select d.local_status::text as status, count(*) as n from public.domains d
                                 where d.test_mode = p_test_mode and d.source <> 'demo' group by 1) s));
  if not v_admin.test_only then
    select coalesce(jsonb_agg(jsonb_build_object(
             'job', j.jobname, 'schedule', j.schedule, 'lastRunAt', last.start_time, 'lastStatus', last.status,
             'lastSuccessAt', (select max(coalesce(d.end_time, d.start_time)) from cron.job_run_details d
                                where d.jobid = j.jobid and d.status = 'succeeded')) order by j.jobname), '[]'::jsonb)
      into v_cron
      from cron.job j
      left join lateral (select d.status, d.start_time from cron.job_run_details d
                          where d.jobid = j.jobid order by d.start_time desc nulls last, d.runid desc limit 1) last on true;
    v_out := jsonb_set(v_out, '{health,cron}', v_cron);
  end if;
  return v_out;
end;
$$;

-- ── 2. Customers by id ──────────────────────────────────────────────────────
-- As migration 41, plus `p_filter.userIds`: an array of uuids narrows the list
-- to those accounts (an empty array to none). Anything else under that key is
-- refused, never read as "no filter". A test admin still sees e2e users only.

create or replace function public.admin_customers(p_test_mode boolean, p_sort text, p_dir text, p_offset integer,
                                                  p_limit integer, p_filter jsonb)
returns table (user_id uuid, account_type text, masked_email text, joined_at timestamptz, domains_held bigint,
               orders_paid bigint, total_paid_kobo bigint, has_totp boolean, email_confirmed boolean,
               last_sign_in_at timestamptz, is_admin boolean, total_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- A test admin reads the test side only (D15); e2e users' profiles only, below.
  v_admin public.admins := public.admin_read_gate(p_test_mode);
  v_sort  text := case when p_sort in ('joined', 'domains', 'orders', 'paid', 'last_sign_in') then p_sort else 'joined' end;
  v_asc   boolean := lower(coalesce(p_dir, 'desc')) = 'asc';
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_f     jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_ids   uuid[];
begin
  if v_f ? 'userIds' then
    if jsonb_typeof(v_f -> 'userIds') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'admin:bad_filter';
    end if;
    -- A value that is not a uuid raises (22P02); an empty array matches no one.
    v_ids := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_f -> 'userIds') as x), '{}'::uuid[]);
  end if;
  return query
  with base as (
    select p.id, p.account_type::text as account_type, public.admin_mask_email(p.email::text) as masked_email,
           p.created_at as joined_at,
           (select count(*) from public.domains d
             where d.user_id = p.id and d.test_mode = p_test_mode and d.source <> 'demo'
               and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')) as domains_held,
           (select count(*) from public.orders o where o.user_id = p.id and o.test_mode = p_test_mode and o.paid_at is not null) as orders_paid,
           (select coalesce(sum(o.total_kobo), 0) from public.orders o
             where o.user_id = p.id and o.test_mode = p_test_mode and o.paid_at is not null)::bigint as total_paid_kobo,
           exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified' and f.factor_type = 'totp') as has_totp,
           u.email_confirmed_at is not null as email_confirmed,
           u.last_sign_in_at,
           exists (select 1 from public.admins a where a.user_id = p.id and a.revoked_at is null) as is_admin
      from public.profiles p
      left join auth.users u on u.id = p.id
     -- D15: a test admin sees e2e users' profiles only, as customer.reveal.
     where (not v_admin.test_only or public.admin_e2e_email(p.email::text))
       and (v_ids is null or p.id = any (v_ids))
       and (v_f ->> 'accountType' is null or p.account_type::text = v_f ->> 'accountType')
  ), filtered as (
    select b.* from base b
     where (v_f ->> 'hasTotp' is null or b.has_totp = (v_f ->> 'hasTotp')::boolean)
       and (v_f ->> 'holders' is null or (b.domains_held > 0) = (v_f ->> 'holders')::boolean)
  )
  select f.id, f.account_type, f.masked_email, f.joined_at, f.domains_held, f.orders_paid, f.total_paid_kobo,
         f.has_totp, f.email_confirmed, f.last_sign_in_at, f.is_admin, count(*) over ()
    from filtered f
   order by
     case when v_sort = 'joined' and v_asc then f.joined_at end asc nulls last,
     case when v_sort = 'joined' and not v_asc then f.joined_at end desc nulls last,
     case when v_sort = 'domains' and v_asc then f.domains_held end asc nulls last,
     case when v_sort = 'domains' and not v_asc then f.domains_held end desc nulls last,
     case when v_sort = 'orders' and v_asc then f.orders_paid end asc nulls last,
     case when v_sort = 'orders' and not v_asc then f.orders_paid end desc nulls last,
     case when v_sort = 'paid' and v_asc then f.total_paid_kobo end asc nulls last,
     case when v_sort = 'paid' and not v_asc then f.total_paid_kobo end desc nulls last,
     case when v_sort = 'last_sign_in' and v_asc then f.last_sign_in_at end asc nulls last,
     case when v_sort = 'last_sign_in' and not v_asc then f.last_sign_in_at end desc nulls last,
     f.id
   offset v_off limit v_limit;
end;
$$;

-- ── 3. The stuck-order threshold ────────────────────────────────────────────
-- One number from ops_settings, for "Stuck only": the same minutes
-- admin_attention_counts and the order_stuck alert use. Global, so a test
-- admin may read it; the rest of ops_settings stays refused to them.

create function public.admin_stuck_order_minutes()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_session('viewer', null, false);
  return (select s.stuck_order_minutes from public.ops_settings s where s.id);
end;
$$;

-- ── 4. The example extension, in cents ──────────────────────────────────────
-- As migration 41, plus `example`: .com's catalogue row as the pricing pages
-- price it, its yearly costs in whole cents (D24). A cost that is not a whole
-- number of cents is null: a cost rounded to the cent would build a price the
-- site does not charge, so the page shows no example then (N5b).

create or replace function public.admin_pricing_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_example constant text := 'com';
  v_active public.fx_rates;
begin
  perform public.admin_session('viewer', null, false);
  select * into v_active from public.fx_rates where status = 'active' order by effective_from desc nulls last limit 1;
  return jsonb_build_object(
    'tlds', (select jsonb_build_object('total', count(*), 'sellable', count(*) filter (where t.is_sellable),
                                       'paused', count(*) filter (where t.is_paused),
                                       'featured', count(*) filter (where t.featured_rank is not null),
                                       'transferable', count(*) filter (where t.is_transferable))
               from public.tlds t),
    'ssl', (select jsonb_build_object('total', count(*), 'sellable', count(*) filter (where s.is_sellable),
                                      'priced', count(*) filter (where s.create_usd is not null))
              from public.ssl_products s),
    'fx', jsonb_build_object(
      'active', case when v_active.id is null then null else jsonb_build_object(
                  'id', v_active.id, 'costingRate', v_active.costing_rate, 'source', v_active.source,
                  'quotedAt', v_active.quoted_at, 'effectiveFrom', v_active.effective_from) end,
      'pending', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', f.id, 'costingRate', f.costing_rate, 'source', f.source, 'quotedAt', f.quoted_at,
                    'movePct', f.move_pct,
                    'tooOld', f.quoted_at < now() - interval '48 hours',
                    'olderThanActive', v_active.id is not null and f.quoted_at <= v_active.quoted_at)
                    order by f.quoted_at desc), '[]'::jsonb)
                    from public.fx_rates f where f.status = 'pending_review')),
    'settings', (select jsonb_build_object('marginNgn', p.margin_ngn, 'fxBufferPct', p.fx_buffer_pct,
                                           'icannFeeCents', round(p.icann_fee_usd * 100)::bigint,
                                           'fxMoveThresholdPct', p.fx_move_threshold_pct, 'vatPct', p.vat_pct)
                   from public.pricing_settings p where p.id),
    'example', (select jsonb_build_object(
                         'name', t.name,
                         'registerCents', case when t.register_usd * 100 = trunc(t.register_usd * 100)
                                               then (t.register_usd * 100)::bigint end,
                         'renewCents', case when t.renew_usd * 100 = trunc(t.renew_usd * 100)
                                            then (t.renew_usd * 100)::bigint end,
                         'isCountryCode', t.is_country_code, 'minPeriod', t.min_period, 'maxPeriod', t.max_period,
                         'registerPeriods', t.register_periods, 'renewPeriods', t.renew_periods,
                         'isSellable', t.is_sellable, 'isPaused', t.is_paused)
                  from public.tlds t where t.name = c_example));
end;
$$;

-- ── 5. A job's ledger check, as a count ─────────────────────────────────────
-- For B4's Fail precondition panel: "Ledger last read 14:15 WAT; no charge
-- for example.com since this job started." The charges are counted exactly
-- as admin_fail_job tests them before it refuses LEDGER_SHOWS_CHARGE: domain
-- debits on the job's side naming its domain (exact, or within the
-- description) after the job was created. `readAt` is the last successful
-- read, as float_runway takes it: a charge made after it is not in the
-- mirror yet. No entry is returned — the ledger's rows are B6's (§9).
-- Null when the side has no such job.

create function public.admin_job_ledger(p_test_mode boolean, p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_read_gate(p_test_mode);
  v_job   public.jobs;
  v_name  text;
  v_hb    public.service_heartbeats;
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.test_mode = p_test_mode;
  if not found then
    return null;
  end if;
  select d.domain_name::text into v_name from public.domains d where d.id = v_job.domain_id;
  select * into v_hb from public.service_heartbeats h
   where h.name = 'supplier_ledger:' || case when p_test_mode then 'ote' else 'production' end;
  return jsonb_build_object(
    'jobId', v_job.id,
    'since', v_job.created_at,
    'syncedAt', v_hb.beat_at,
    'outcome', v_hb.detail ->> 'outcome',
    'readAt', public.try_timestamptz(case when v_hb.detail ->> 'outcome' = 'ok' then v_hb.detail ->> 'readAt'
                                          else v_hb.detail ->> 'lastOkReadAt' end),
    'charges', (select count(*) from public.supplier_ledger_entries e
                 where e.test_mode = v_job.test_mode and e.product_type = 1 and e.delta_cents < 0
                   and e.occurred_at > v_job.created_at
                   and (lower(trim(e.description)) = lower(v_name)
                        or position(lower(v_name) in lower(e.description)) > 0)));
end;
$$;

-- ── 6. A certificate job's name and line ────────────────────────────────────
-- For B4's certificate job page: which certificate (its common name) and
-- which order line (for the line and its refund). Two columns of
-- ssl_certificates and no more; the masked certificate view stays B10's.
-- Null when the side has no such job.

create function public.admin_ssl_job_certificate(p_test_mode boolean, p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin public.admins := public.admin_read_gate(p_test_mode);
begin
  return (select jsonb_build_object('commonName', c.common_name, 'orderItemId', c.order_item_id)
            from public.ssl_jobs j join public.ssl_certificates c on c.id = j.certificate_id
           where j.id = p_job_id and j.test_mode = p_test_mode);
end;
$$;

-- ── 7. A featured rank already taken is a refusal ───────────────────────────
-- As migration 40, except that the update's unique violation on
-- tlds_featured_rank_unique — another extension holds that rank — is
-- recorded and answered as RANK_TAKEN like every other refusal, instead of
-- raising out of the wrapper with no audit row. Nothing is changed then.

create or replace function public.admin_set_tld_flags(p_name text, p_is_paused boolean, p_paused_reason text,
                                                      p_featured_rank integer, p_featured_tagline text, p_reason text,
                                                      p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'extension.flags';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_prior  jsonb;
  v_name   text := lower(trim(coalesce(p_name, '')));
  v_tld    public.tlds;
  v_paused boolean;
  v_sent   text := nullif(trim(coalesce(p_paused_reason, '')), '');
  v_why    text;
  v_rank   integer;
  v_tag    text;
  v_code   text;
  v_detail jsonb;
  v_index  text;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, v_name);
  if v_prior is not null then return v_prior; end if;
  select * into v_tld from public.tlds where name = v_name for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'global', 'tld', left(v_name, 200), null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_paused := coalesce(p_is_paused, v_tld.is_paused);
  -- A new pause needs its reason; one already paused keeps it unless a new one is sent.
  v_why := case when not v_paused then null
                when v_sent is not null then v_sent
                when v_tld.is_paused then v_tld.paused_reason end;
  v_rank := case when p_featured_rank is null then v_tld.featured_rank
                 when p_featured_rank = 0 then null
                 else p_featured_rank end;
  v_tag := case when p_featured_tagline is null then v_tld.featured_tagline
                else nullif(trim(p_featured_tagline), '') end;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('is_paused', v_tld.is_paused, 'paused_reason', v_tld.paused_reason,
                                 'featured_rank', v_tld.featured_rank, 'featured_tagline', v_tld.featured_tagline),
    'held_domains', (select count(*) from public.domains d
                      where d.tld = v_tld.name and d.source <> 'demo'
                        and d.local_status in ('active', 'expired_grace', 'redemption', 'pending_delete', 'pending_verification')));
  v_code := coalesce(public.admin_gate(v_admin, c_action, false), public.admin_reason_problem(p_reason));
  -- Only a reason sent now is judged: a stored one stands as it was written.
  if v_code is null and v_paused and (v_sent is not null or v_why is null)
     and char_length(coalesce(v_why, '')) not between 3 and 120 then
    v_code := 'PAUSE_REASON';
  end if;
  if v_code is null and p_featured_rank is not null and p_featured_rank not between 0 and 50 then
    v_code := 'OUT_OF_RANGE';
  end if;
  if v_code is null and char_length(coalesce(trim(p_featured_tagline), '')) > 60 then v_code := 'OUT_OF_RANGE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, 'global', 'tld', v_tld.name, null,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  begin
    update public.tlds
       set is_paused = v_paused,
           paused_reason = v_why,
           featured_rank = v_rank,
           featured_tagline = v_tag
     where name = v_tld.name;
  exception when unique_violation then
    get stacked diagnostics v_index = constraint_name;
    if v_index is distinct from 'tlds_featured_rank_unique' then
      raise;
    end if;
    -- The update is undone with its block; the refusal is recorded like any other.
    return public.admin_record(v_admin, c_action, 'global', 'tld', v_tld.name, null,
      p_reason, p_request_key, 'refused', 'RANK_TAKEN', null,
      v_detail || jsonb_build_object('asked', jsonb_build_object('featured_rank', v_rank),
                                     'rank_held_by', (select t.name from public.tlds t
                                                       where t.featured_rank = v_rank and t.name <> v_tld.name)));
  end;
  return public.admin_record(v_admin, c_action, 'global', 'tld', v_tld.name, null,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('is_paused', t.is_paused,
                 'paused_reason', t.paused_reason, 'featured_rank', t.featured_rank,
                 'featured_tagline', t.featured_tagline) from public.tlds t where t.name = v_tld.name)));
end $$;

-- ── Grants (§3.0): revoked from every API role, granted to one ──────────────

revoke all on function public.admin_overview(boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_customers(boolean, text, text, integer, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_stuck_order_minutes() from public, anon, authenticated, service_role;
revoke all on function public.admin_pricing_status() from public, anon, authenticated, service_role;
revoke all on function public.admin_job_ledger(boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_ssl_job_certificate(boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_tld_flags(text, boolean, text, integer, text, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.admin_overview(boolean) to authenticated;
grant execute on function public.admin_customers(boolean, text, text, integer, integer, jsonb) to authenticated;
grant execute on function public.admin_stuck_order_minutes() to authenticated;
grant execute on function public.admin_pricing_status() to authenticated;
grant execute on function public.admin_job_ledger(boolean, uuid) to authenticated;
grant execute on function public.admin_ssl_job_certificate(boolean, uuid) to authenticated;
grant execute on function public.admin_set_tld_flags(text, boolean, text, integer, text, text, uuid) to authenticated;
