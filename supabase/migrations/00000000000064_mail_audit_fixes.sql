-- MyDomainsHub Mail: four findings of the security audit, 8 Oct 2026.
--
--   1. reserve_send: the monthly cap counts the whole calendar month of the
--      send day, so emails scheduled for later days of it cannot each see
--      room that the others already took (medium).
--   2. claim_webhook_deliveries: at most two deliveries in flight per
--      endpoint and five per account per batch (medium).
--   3. resend_webhook_delivery: a resend of a resend counts as the original,
--      and an account resends at most webhook_resend_hourly_cap an hour.
--   4. domain_name_ok: well-known public suffixes (com.ng, co.uk,
--      vercel.app…) are not domains anyone can claim (medium).
--
-- Each function is as its last migration left it, with only that change.

alter table mail.settings
  add column webhook_resend_hourly_cap integer not null default 100
    check (webhook_resend_hourly_cap between 1 and 10000);

create or replace function mail.reserve_send(p_account_id uuid, p_api_key_id uuid, p_from_address text,
                                  p_recipients text[], p_send_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  mail.accounts;
  v_settings mail.settings;
  v_key      mail.api_keys;
  v_domain   mail.domains;
  v_n        integer := coalesce(cardinality(p_recipients), 0);
  v_from     text := mail.address_of(p_from_address);
  -- The moment it is to go: its own day, month and hour are the ones it counts against.
  v_at       timestamptz := greatest(coalesce(p_send_at, now()), now());
  v_today    date := mail.lagos_day(greatest(coalesce(p_send_at, now()), now()));
  v_month    date := date_trunc('month', mail.lagos_day(greatest(coalesce(p_send_at, now()), now()))::timestamp)::date;
  v_hour     timestamptz := date_trunc('hour', greatest(coalesce(p_send_at, now()), now()));
  v_over     boolean;
  v_caps     record;
  v_day_used integer;
  v_mon_used bigint;
  v_total    bigint;
  v_mine     bigint;
  v_allowed  bigint;
begin
  select * into v_account from mail.accounts where id = p_account_id for update;
  if v_account.id is null or v_account.state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if v_account.state = 'paused' or v_account.ses_status = 'disabled' then
    return jsonb_build_object('ok', false, 'code', 'account_paused');
  end if;
  if v_account.tenant_ready_at is null then
    return jsonb_build_object('ok', false, 'code', 'account_not_ready');
  end if;
  if p_api_key_id is not null then
    select * into v_key from mail.api_keys where id = p_api_key_id;
    if v_key.id is null or v_key.account_id <> p_account_id or v_key.revoked_at is not null then
      return jsonb_build_object('ok', false, 'code', 'unauthorized');
    end if;
  end if;

  select * into v_domain from mail.domains d
   where d.account_id = p_account_id and d.status = 'verified'
     and d.name = substring(v_from from '@([^@]+)$');
  -- §7.2 with MR2: in the sandbox, the account's sandbox sender, from its one
  -- address (migration 47's sandbox_domain_for; migration 52 asks the same at send time).
  if v_domain.id is null and v_account.state = 'sandbox' then
    select * into v_domain from mail.domains d
     where d.id = mail.sandbox_domain_for(p_account_id, p_from_address);
  end if;
  if v_domain.id is null then
    return jsonb_build_object('ok', false, 'code', 'domain_not_verified');
  end if;
  if v_key.domain_id is not null and v_key.domain_id <> v_domain.id then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'reason', 'key_domain');
  end if;

  if v_n < 1 or v_n > 50
     or exists (select 1 from unnest(p_recipients) r where r is null or r <> lower(r) or r !~ '^[^@\s<>]+@[^@\s<>]+$') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients');
  end if;

  -- §7.2: the sandbox sends only to its own members' confirmed addresses.
  if v_account.state = 'sandbox' and exists (
       select 1 from unnest(p_recipients) r
        where not exists (
          select 1 from mail.members m join auth.users u on u.id = m.user_id
           where m.account_id = p_account_id and lower(u.email) = r and u.email_confirmed_at is not null)) then
    return jsonb_build_object('ok', false, 'code', 'sandbox_recipient');
  end if;

  if exists (select 1 from mail.suppressions s where s.account_id = p_account_id and s.address = any (p_recipients)) then
    return jsonb_build_object('ok', false, 'code', 'suppressed', 'domainId', v_domain.id);
  end if;

  -- The plan's caps for today and this month (Lagos), in recipients.
  select * into v_caps from mail.effective_caps(v_account);
  select coalesce(sum(u.queued) filter (where u.day = v_today), 0),
         coalesce(sum(u.queued), 0)
    into v_day_used, v_mon_used
    from mail.usage_daily u
   -- The whole calendar month of the send day: recipients already reserved
   -- for later days of it count too, so scheduling cannot beat the cap
   -- (security audit, 8 Oct 2026).
   where u.account_id = p_account_id and u.day >= v_month and u.day < (v_month + interval '1 month')::date;
  if v_day_used + v_n > v_caps.daily then
    perform mail.note_cap_use(p_account_id, 'day', v_today, v_caps.daily, v_day_used, true);
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'day', 'cap', v_caps.daily,
                              'retryAfter', ceil(extract(epoch from
                                ((v_today + 1)::timestamp at time zone 'Africa/Lagos') - now()))::integer);
  end if;
  if v_mon_used + v_n > v_caps.monthly then
    perform mail.note_cap_use(p_account_id, 'month', v_month, v_caps.monthly, v_mon_used, true);
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'scope', 'month', 'cap', v_caps.monthly,
                              'retryAfter', ceil(extract(epoch from
                                ((v_month + interval '1 month') at time zone 'Africa/Lagos') - now()))::integer);
  end if;

  -- The SES account's shared 24-hour budget (§4.4, owner 6 Oct 2026). One
  -- lock for every account, so concurrent reservations cannot overshoot it;
  -- no account may hold more than half of what the others leave. Every
  -- 24-hour window holding the send hour must keep both rules — the hours
  -- in (send − 24h, send + 24h), window by window — so emails scheduled
  -- for one moment cannot pile up past the budget.
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mail.send_budget', 0));
  select coalesce(bool_or(w.total + v_n > v_settings.account_daily_budget
                          or w.mine + v_n > floor((v_settings.account_daily_budget - (w.total - w.mine)) / 2.0)),
                  false)
    into v_over
    from generate_series(v_hour - interval '23 hours', v_hour, interval '1 hour') s(start)
    cross join lateral (
      select coalesce(sum(b.recipients), 0) as total,
             coalesce(sum(b.recipients) filter (where b.account_id = p_account_id), 0) as mine
        from mail.send_budget_hourly b
       where b.hour >= s.start and b.hour < s.start + interval '24 hours') w;
  if v_over then
    return jsonb_build_object('ok', false, 'code', 'budget_exceeded',
                              'retryAfter', ceil(extract(epoch from (date_trunc('hour', now()) + interval '1 hour') - now()))::integer);
  end if;

  perform mail.bump_usage(p_account_id, v_today, 'queued', v_n);
  insert into mail.send_budget_hourly as b (hour, account_id, recipients) values (v_hour, p_account_id, v_n)
  on conflict (hour, account_id) do update set recipients = b.recipients + v_n;
  -- §8: 80% and 100% of today's and this month's caps, noted once each.
  perform mail.note_cap_use(p_account_id, 'day', v_today, v_caps.daily, v_day_used + v_n, false);
  perform mail.note_cap_use(p_account_id, 'month', v_month, v_caps.monthly, v_mon_used + v_n, false);
  return jsonb_build_object('ok', true, 'domainId', v_domain.id, 'recipients', v_n,
                            'reservedOn', v_today, 'reservedHour', v_hour, 'sendAt', v_at);
end;
$$;

create or replace function mail.claim_webhook_deliveries(p_worker text, p_limit integer, p_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_out jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 100 then
    raise exception 'claim_webhook_deliveries: a worker name and a limit of 1 to 100' using errcode = '22023';
  end if;

  update mail.webhook_deliveries
     set status = 'pending', claimed_by = null, claimed_at = null, next_attempt_at = now(), updated_at = now()
   where status = 'delivering' and claimed_at < now() - interval '5 minutes';

  -- Fair shares (security audit, 8 Oct 2026): at most two deliveries in
  -- flight to one endpoint, and at most five of one account's in a batch,
  -- so one slow or flooded endpoint cannot hold every customer's webhooks.
  for v_row in
    with due as (
      select d.id, d.webhook_id, d.account_id, d.next_attempt_at,
             row_number() over (partition by d.webhook_id order by d.next_attempt_at, d.id) as per_hook,
             row_number() over (partition by d.account_id order by d.next_attempt_at, d.id) as per_account
        from mail.webhook_deliveries d
        join mail.webhooks w on w.id = d.webhook_id
        join mail.accounts a on a.id = d.account_id
       where d.status = 'pending' and d.next_attempt_at <= now() and w.status = 'enabled'
         and case when p_account_id is null then not a.is_e2e else d.account_id = p_account_id end
    ), busy as (
      select x.webhook_id, count(*) as n
        from mail.webhook_deliveries x
       where x.status = 'delivering'
       group by x.webhook_id
    ), picked as (
      select due.id
        from due left join busy on busy.webhook_id = due.webhook_id
       where due.per_hook <= 2 - coalesce(busy.n, 0)
         and due.per_account <= 5
       order by due.next_attempt_at, due.id
       limit p_limit
    )
    select d.id, d.webhook_id, d.account_id, d.message_id, d.event_type, d.payload, d.attempts,
           w.url, w.secret_sealed
      from mail.webhook_deliveries d
      join mail.webhooks w on w.id = d.webhook_id
     where d.id in (select picked.id from picked) and d.status = 'pending'
     order by d.next_attempt_at, d.id
     for update of d skip locked
  loop
    update mail.webhook_deliveries
       set status = 'delivering', claimed_by = p_worker, claimed_at = now(), attempts = attempts + 1,
           last_attempt_at = now(), updated_at = now()
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'webhookId', v_row.webhook_id, 'accountId', v_row.account_id, 'url', v_row.url,
      'secretSealed', v_row.secret_sealed, 'messageId', v_row.message_id, 'eventType', v_row.event_type,
      'payload', v_row.payload, 'attempt', v_row.attempts + 1));
  end loop;
  return v_out;
end;
$$;

create or replace function mail.resend_webhook_delivery(p_account_id uuid, p_delivery_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_delivery mail.webhook_deliveries;
  v_found    record;
  v_hours    integer;
  v_id       bigint;
  v_original bigint;
  v_resent   integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  select * into v_delivery from mail.webhook_deliveries d
   where d.id = p_delivery_id and d.account_id = p_account_id;
  if v_delivery.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_found from mail.webhook_for_caller(p_account_id, v_delivery.webhook_id);
  if not found or v_found.role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_found.role not in ('owner', 'admin', 'developer') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_found.account_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if (v_found.webhook).status <> 'enabled' then
    return jsonb_build_object('ok', false, 'code', 'webhook_disabled');
  end if;
  -- A resend of a resend is a resend of the original: one at a time each,
  -- and at most webhook_resend_hourly_cap an hour per account, so resends
  -- cannot multiply (security audit, 8 Oct 2026).
  v_original := coalesce(v_delivery.resend_of, v_delivery.id);
  if exists (select 1 from mail.webhook_deliveries d
              where (d.id = v_original or d.resend_of = v_original)
                and d.status in ('pending', 'delivering')) then
    return jsonb_build_object('ok', false, 'code', 'in_progress');
  end if;
  select count(*) into v_resent from mail.webhook_deliveries d
   where d.account_id = p_account_id and d.resend_of is not null
     and d.created_at > now() - interval '1 hour';
  if v_resent >= (select s.webhook_resend_hourly_cap from mail.settings s where s.id) then
    return jsonb_build_object('ok', false, 'code', 'too_many_resends');
  end if;
  select s.webhook_retry_hours into v_hours from mail.settings s where s.id;
  insert into mail.webhook_deliveries (webhook_id, account_id, message_id, event_type, payload, email_id,
                                       give_up_at, resend_of)
  values (v_delivery.webhook_id, v_delivery.account_id, v_delivery.message_id, v_delivery.event_type,
          v_delivery.payload, v_delivery.email_id, now() + make_interval(hours => coalesce(v_hours, 24)),
          v_original)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'deliveryId', v_id);
end;
$$;

create or replace function mail.domain_name_ok(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_name) between 4 and 200
                  and p_name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
                  -- A public suffix is nobody's domain: a pending claim on com.ng
                  -- blocked every name under it (security audit, 8 Oct 2026).
                  and p_name <> all (array[
                    'com.ng', 'org.ng', 'net.ng', 'gov.ng', 'edu.ng', 'sch.ng', 'name.ng', 'mil.ng',
                    'mobi.ng', 'i.ng', 'biz.ng',
                    'com.gh', 'org.gh', 'gov.gh', 'edu.gh', 'co.ke', 'or.ke', 'go.ke', 'ac.ke', 'ne.ke',
                    'co.za', 'org.za', 'gov.za', 'ac.za', 'net.za', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
                    'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
                    'com.br', 'co.in', 'co.jp', 'com.cn', 'com.eg', 'co.tz', 'co.ug', 'co.zw', 'com.sg',
                    'vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'workers.dev', 'herokuapp.com',
                    'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
                    'blogspot.com', 'wordpress.com', 'wixsite.com', 'onrender.com', 'fly.dev'
                  ]), false)
$$;
