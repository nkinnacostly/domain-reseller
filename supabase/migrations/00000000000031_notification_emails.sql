-- ─────────────────────────────────────────────────────────────────────────────
-- Notification emails (PRD E12, §16.1): receipts, what happened to each
-- domain, refunds, security notices (SEC-4), the ERRP expiry notices (§7.4)
-- and the one-time "not pointed anywhere yet" nudge (FR-D8).
--
-- An outbox. Whatever causes an email queues it in the same transaction —
-- a trigger on the event, the payment or the refund, or a daily job — so an
-- email is queued exactly when the thing it reports happened, once
-- (`dedupe_key`). The gateway claims queued emails one side at a time
-- (`claim_emails(p_test_mode)`, like jobs), renders them from versioned
-- templates in @dr/shared and sends them through Brevo. Sending is
-- at-least-once: a timeout after Brevo accepted a message may repeat it,
-- which for an email is a duplicate, not a loss.
--
-- ERRP notices are compliance artefacts (FR-ERRP-1): each sent one is
-- recorded in `compliance_notices` with its template version and recipient,
-- kept three years, and its delivery is read back from Brevo; a bounce is an
-- ops alert (FR-NT3). Email is the only channel we have: SMS and WhatsApp
-- (FR-NT1) need a provider.
--
-- Nothing here is sent to a reserved address (example.com, .test, .invalid…):
-- e2e accounts live there, and bounces cost the sending domain its name.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.email_outbox (
  id                   uuid primary key default extensions.gen_random_uuid(),
  kind                 text not null check (kind ~ '^[a-z_]+$'),
  category             text not null check (category in ('transactional', 'security', 'compliance')),
  user_id              uuid references public.profiles (id) on delete cascade,
  domain_id            uuid references public.domains (id) on delete set null,
  order_id             uuid references public.orders (id) on delete set null,
  to_email             text not null,
  -- What the template needs, captured when the email was queued.
  data                 jsonb not null default '{}',
  dedupe_key           text not null unique,
  test_mode            boolean not null default false,
  status               text not null default 'pending'
                       check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  skip_reason          text,
  attempts             integer not null default 0,
  next_attempt_at      timestamptz not null default now(),
  claimed_by           text,
  claimed_at           timestamptz,
  -- FR-NT4: the template that produced the message, recorded on sending.
  template_version     text,
  provider_message_id  text,
  sent_at              timestamptz,
  delivery_status      text check (delivery_status in ('delivered', 'bounced', 'deferred')),
  delivery_checked_at  timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index email_outbox_due_idx
  on public.email_outbox (test_mode, next_attempt_at) where status in ('pending', 'sending');
create index email_outbox_user_idx on public.email_outbox (user_id, created_at desc);

create trigger email_outbox_set_updated_at
  before update on public.email_outbox
  for each row execute function public.set_updated_at();

-- FR-ERRP-1: every ERRP notice sent, kept three years, never mixed with other mail.
create table public.compliance_notices (
  id                   uuid primary key default extensions.gen_random_uuid(),
  email_id             uuid unique references public.email_outbox (id) on delete set null,
  domain_id            uuid references public.domains (id) on delete set null,
  user_id              uuid references public.profiles (id) on delete set null,
  domain_name          text not null,
  notice_type          text not null check (notice_type in ('errp_pre_35', 'errp_pre_7', 'errp_post')),
  expires_at           timestamptz not null,
  channel              text not null default 'email' check (channel = 'email'),
  recipient            text not null,
  template_version     text not null,
  sent_at              timestamptz not null,
  provider_message_id  text,
  delivery_status      text not null default 'sent'
                       check (delivery_status in ('sent', 'delivered', 'bounced')),
  delivery_checked_at  timestamptz,
  created_at           timestamptz not null default now()
);
create index compliance_notices_domain_idx on public.compliance_notices (domain_id, sent_at desc);

-- SEC-4: the devices an account has signed in from, to tell a new one.
-- "Chrome on macOS", not an address or a fingerprint: enough to warn, no more.
create table public.known_devices (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  device         text not null check (char_length(device) between 1 and 80),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  primary key (user_id, device)
);

alter table public.email_outbox       enable row level security;
alter table public.compliance_notices enable row level security;
alter table public.known_devices      enable row level security;
-- No policies: nobody reads these through the API. The server key reads
-- them (tests, ops); every write goes through the functions below.
revoke all on public.email_outbox, public.compliance_notices, public.known_devices
  from anon, authenticated;
revoke insert, update, delete, truncate
  on public.email_outbox, public.compliance_notices, public.known_devices
  from service_role;
grant select on public.email_outbox, public.compliance_notices, public.known_devices
  to service_role;

-- ── Queueing ────────────────────────────────────────────────────────────────

-- Addresses that must never receive mail: RFC 2606 / 6761 names.
create or replace function public.is_reserved_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    lower(split_part(p_email, '@', 2)) in ('example.com', 'example.net', 'example.org', 'localhost')
    or lower(split_part(p_email, '@', 2)) ~ '\.(example|test|invalid|localhost)$'
    or position('@' in coalesce(p_email, '')) = 0,
    true)
$$;

-- The one way an email is queued. Deduplicated on the key; the recipient is
-- the account's address now. Returns the new row's id, or null when there
-- is nothing to queue (already queued, or no such account).
create or replace function public.queue_email(
  p_kind       text,
  p_category   text,
  p_user_id    uuid,
  p_dedupe_key text,
  p_data       jsonb default '{}',
  p_domain_id  uuid default null,
  p_order_id   uuid default null,
  p_test_mode  boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id      uuid;
  v_skip    boolean;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if v_profile.id is null or coalesce(v_profile.email, '') = '' then
    return null;
  end if;
  v_skip := public.is_reserved_email(v_profile.email);

  insert into public.email_outbox (kind, category, user_id, domain_id, order_id, to_email, data,
                                   dedupe_key, test_mode, status, skip_reason)
  values (p_kind, p_category, p_user_id, p_domain_id, p_order_id, v_profile.email,
          coalesce(p_data, '{}'::jsonb)
            || jsonb_build_object('name', nullif(split_part(coalesce(v_profile.full_name, ''), ' ', 1), '')),
          p_dedupe_key, coalesce(p_test_mode, false),
          case when v_skip then 'skipped' else 'pending' end,
          case when v_skip then 'reserved_address' end)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- What happened to a domain, told to its owner. Registrations, renewals and
-- transfers in are transactional; changes that could be someone else's
-- doing are security notices (SEC-4) and cannot be switched off.
create or replace function public.email_for_domain_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain   public.domains;
  v_kind     text;
  v_category text := 'transactional';
  v_key      text := 'event:' || new.id;
  v_data     jsonb;
begin
  select * into v_domain from public.domains where id = new.domain_id;
  if v_domain.id is null or v_domain.source = 'demo' then
    return null;
  end if;
  v_data := jsonb_build_object('domain', v_domain.domain_name);

  case new.event_type
    when 'registered' then
      v_kind := 'domain_registered';
      v_key := 'domain_registered:' || v_domain.id;
      v_data := v_data || jsonb_build_object('expires_at', new.payload -> 'expires_at',
                                             'nameservers', to_jsonb(v_domain.nameservers));
    when 'renewed' then
      v_kind := 'domain_renewed';
      v_data := v_data || jsonb_build_object('years', new.payload -> 'years',
                                             'expires_at', new.payload -> 'to');
    when 'transfer_submitted' then
      v_kind := 'transfer_started';
      v_key := 'transfer_started:' || v_domain.id;
    when 'transferred_in' then
      v_kind := 'transfer_completed';
      v_key := 'transfer_completed:' || v_domain.id;
      v_data := v_data || jsonb_build_object('expires_at', new.payload -> 'expires_at');
    when 'registration_failed', 'renewal_failed', 'transfer_failed' then
      v_kind := 'order_line_failed';
      v_data := v_data || jsonb_build_object(
        'action', split_part(new.event_type, '_', 1),
        'code', new.payload ->> 'code');
    when 'nameservers_applied' then
      -- Nameservers set as part of the registration or transfer itself
      -- (same transaction, so the same now()) are not a change.
      if exists (select 1 from public.domain_events e
                  where e.domain_id = new.domain_id
                    and e.event_type in ('registered', 'transferred_in')
                    and e.created_at = new.created_at) then
        return null;
      end if;
      v_kind := 'nameservers_changed';
      v_category := 'security';
      v_data := v_data || jsonb_build_object('nameservers', new.payload -> 'nameservers');
    when 'transfer_lock_applied' then
      v_kind := 'transfer_lock_changed';
      v_category := 'security';
      v_data := v_data || jsonb_build_object('locked', new.payload -> 'transfer_lock');
    when 'contacts_applied' then
      v_kind := 'contacts_changed';
      v_category := 'security';
    when 'auth_code_revealed' then
      v_kind := 'auth_code_revealed';
      v_category := 'security';
    else
      return null;
  end case;

  perform public.queue_email(v_kind, v_category, v_domain.user_id, v_key,
                             v_data || jsonb_build_object('at', new.created_at),
                             v_domain.id, null, v_domain.test_mode);
  return null;
end;
$$;

create trigger domain_events_email
  after insert on public.domain_events
  for each row execute function public.email_for_domain_event();

-- FR-C5 / FR-W4: the receipt, when the payment is recorded — every line with
-- its renewal price (N8), as the printable receipt shows it.
create or replace function public.email_for_paid_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_email(
    'order_receipt', 'transactional', new.user_id, 'order_receipt:' || new.id,
    jsonb_build_object(
      'order_id', new.id,
      'order_number', new.order_number,
      'invoice_number', new.invoice_number,
      'paid_at', new.paid_at,
      'subtotal_kobo', new.subtotal_kobo,
      'vat_pct', new.vat_pct,
      'vat_kobo', new.vat_kobo,
      'total_kobo', new.total_kobo,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'domain', oi.domain,
                 'kind', oi.item_type,
                 'years', oi.period_years,
                 'price_kobo', oi.price_kobo,
                 'renewal_kobo', oi.renewal_kobo)
               order by oi.created_at, oi.domain)
          from public.order_items oi
         where oi.order_id = new.id), '[]'::jsonb)),
    null, new.id, new.test_mode);
  return null;
end;
$$;

create trigger orders_receipt_email
  after update of invoice_number on public.orders
  for each row
  when (old.invoice_number is null and new.invoice_number is not null)
  execute function public.email_for_paid_order();

-- FR-R3: a refund has gone to Flutterwave (or was paid by hand) — the money
-- is on its way to the card or account that paid.
create or replace function public.email_for_sent_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order  public.orders;
  v_domain text;
begin
  select * into v_order from public.orders where id = new.order_id;
  select oi.domain into v_domain from public.order_items oi where oi.id = new.order_item_id;
  perform public.queue_email(
    'refund_sent', 'transactional', new.user_id, 'refund_sent:' || new.id,
    jsonb_build_object(
      'order_id', new.order_id,
      'order_number', v_order.order_number,
      'amount_kobo', new.amount_kobo,
      'reason', new.reason,
      'domain', v_domain,
      'at', new.submitted_at),
    null, new.order_id, new.test_mode);
  return null;
end;
$$;

create trigger refunds_sent_email
  after update of submitted_at on public.refunds
  for each row
  when (old.submitted_at is null and new.submitted_at is not null)
  execute function public.email_for_sent_refund();

-- ── Daily notices ───────────────────────────────────────────────────────────

-- §7.4 ERRP: about a month before expiry (26–35 days), about a week before
-- (4–10 days), and within five days after. Run daily, each notice goes out
-- on the first day its window opens. The key includes the expiry date, so a
-- renewal starts a fresh cycle and a notice is never sent twice for one.
create or replace function public.enqueue_expiry_notices()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row   record;
begin
  for v_row in
    select d.id, d.user_id, d.domain_name, d.expires_at,
           case
             when d.expires_at > now() + interval '26 days'
              and d.expires_at <= now() + interval '35 days' then 'errp_pre_35'
             when d.expires_at > now() + interval '4 days'
              and d.expires_at <= now() + interval '10 days' then 'errp_pre_7'
             when d.expires_at <= now()
              and d.expires_at > now() - interval '5 days' then 'errp_post'
           end as notice
      from public.domains d
     where d.test_mode = false
       and d.source <> 'demo'
       and d.local_status in ('active', 'expired_grace', 'redemption')
       and d.expires_at is not null
       and d.expires_at > now() - interval '5 days'
       and d.expires_at <= now() + interval '35 days'
  loop
    continue when v_row.notice is null;
    if public.queue_email(
         'expiry_notice', 'compliance', v_row.user_id,
         'expiry:' || v_row.id || ':' || to_char(v_row.expires_at at time zone 'UTC', 'YYYY-MM-DD')
           || ':' || v_row.notice,
         jsonb_build_object('domain', v_row.domain_name, 'expires_at', v_row.expires_at,
                            'notice', v_row.notice),
         v_row.id, null, false) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- FR-D8: once, three days after registration, if the domain still points at
-- nothing of the customer's. Only domains registered in the last month, so
-- the first run does not write to people about old domains.
create or replace function public.enqueue_undelegated_nudges()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row   record;
begin
  for v_row in
    select d.id, d.user_id, d.domain_name
      from public.domains d
     where d.test_mode = false
       and d.source <> 'demo'
       and d.local_status = 'active'
       and d.delegation_status = 'undelegated'
       and d.registered_at < now() - interval '3 days'
       and d.registered_at > now() - interval '30 days'
  loop
    if public.queue_email('undelegated_nudge', 'transactional', v_row.user_id,
                          'undelegated:' || v_row.id,
                          jsonb_build_object('domain', v_row.domain_name),
                          v_row.id, null, false) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ── Account security (SEC-4), called by the web with the server key ─────────

-- A sign-in. Returns true when the device is new to an account that has
-- signed in before — the first device of all is simply remembered.
create or replace function public.note_sign_in(p_user_id uuid, p_device text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := left(coalesce(nullif(btrim(p_device), ''), 'Unknown device'), 80);
  v_known  integer;
  v_new    boolean;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return false;
  end if;
  select count(*) into v_known from public.known_devices where user_id = p_user_id;

  insert into public.known_devices (user_id, device) values (p_user_id, v_device)
  on conflict (user_id, device) do update set last_seen_at = now()
  returning (xmax = 0) into v_new;

  if v_new and v_known > 0 then
    perform public.queue_email('new_sign_in', 'security', p_user_id,
                               'new_sign_in:' || p_user_id || ':' || md5(v_device),
                               jsonb_build_object('device', v_device, 'at', now()));
    return true;
  end if;
  return false;
end;
$$;

-- A password or two-factor change the web has just made.
create or replace function public.queue_account_email(p_user_id uuid, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('password_changed', 'two_factor_on', 'two_factor_off') then
    raise exception 'not an account email: %', p_kind using errcode = '22023';
  end if;
  return public.queue_email(p_kind, 'security', p_user_id,
                            p_kind || ':' || p_user_id || ':'
                              || (extract(epoch from clock_timestamp()) * 1000)::bigint,
                            jsonb_build_object('at', now()));
end;
$$;

-- ── Sending, for the gateway ────────────────────────────────────────────────

-- The emails due on one side. A claim left 'sending' for 15 minutes belongs
-- to a worker that died; it is taken again (and may be sent twice).
create or replace function public.claim_emails(p_worker text, p_test_mode boolean, p_limit integer default 10)
returns table (
  id uuid, kind text, category text, to_email text, data jsonb, attempts integer,
  test_mode boolean, user_id uuid, domain_id uuid, order_id uuid
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select e.id
      from public.email_outbox e
     where e.test_mode = p_test_mode
       and ((e.status = 'pending' and e.next_attempt_at <= now())
            or (e.status = 'sending' and e.claimed_at < now() - interval '15 minutes'))
     order by e.next_attempt_at, e.created_at
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  )
  update public.email_outbox e
     set status = 'sending', claimed_by = p_worker, claimed_at = now(), attempts = e.attempts + 1
    from due
   where e.id = due.id
  returning e.id, e.kind, e.category, e.to_email, e.data, e.attempts, e.test_mode,
            e.user_id, e.domain_id, e.order_id
$$;

-- Brevo accepted it. An ERRP notice is also entered in the compliance log.
create or replace function public.mark_email_sent(
  p_id uuid, p_worker text, p_message_id text, p_template_version text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email public.email_outbox;
begin
  update public.email_outbox
     set status = 'sent', sent_at = now(), provider_message_id = left(p_message_id, 200),
         template_version = left(p_template_version, 60), last_error = null
   where id = p_id and status = 'sending' and claimed_by = p_worker
  returning * into v_email;
  if v_email.id is null then
    return false;
  end if;

  if v_email.category = 'compliance' then
    insert into public.compliance_notices (email_id, domain_id, user_id, domain_name, notice_type,
                                           expires_at, recipient, template_version, sent_at,
                                           provider_message_id)
    values (v_email.id, v_email.domain_id, v_email.user_id, v_email.data ->> 'domain',
            v_email.data ->> 'notice', (v_email.data ->> 'expires_at')::timestamptz,
            v_email.to_email, v_email.template_version, v_email.sent_at,
            v_email.provider_message_id);
  end if;
  return true;
end;
$$;

-- Not sent. A permanent refusal (or eight attempts) fails for good — an ops
-- alert; anything else is tried again later, backing off to six hours.
create or replace function public.mark_email_failed(
  p_id uuid, p_worker text, p_error text, p_permanent boolean default false
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with changed as (
    update public.email_outbox
       set status = case when coalesce(p_permanent, false) or attempts >= 8 then 'failed' else 'pending' end,
           last_error = left(p_error, 300),
           next_attempt_at = now() + least(interval '6 hours', make_interval(mins => power(2, attempts)::integer))
     where id = p_id and status = 'sending' and claimed_by = p_worker
    returning 1
  )
  select exists (select 1 from changed)
$$;

-- Deliberately not sent (a reserved address, a template we do not have).
create or replace function public.mark_email_skipped(p_id uuid, p_worker text, p_reason text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with changed as (
    update public.email_outbox
       set status = 'skipped', skip_reason = left(p_reason, 120)
     where id = p_id and status = 'sending' and claimed_by = p_worker
    returning 1
  )
  select exists (select 1 from changed)
$$;

-- FR-NT3: sent compliance and security notices whose delivery is not yet known.
create or replace function public.emails_for_delivery_check(p_limit integer default 50)
returns table (id uuid, provider_message_id text, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.provider_message_id, e.sent_at
    from public.email_outbox e
   where e.status = 'sent'
     and e.category in ('compliance', 'security')
     and e.provider_message_id is not null
     and coalesce(e.delivery_status, 'deferred') = 'deferred'
     and e.sent_at > now() - interval '7 days'
     and (e.delivery_checked_at is null or e.delivery_checked_at < now() - interval '30 minutes')
   order by e.delivery_checked_at nulls first, e.sent_at
   limit greatest(1, least(p_limit, 200))
$$;

-- What Brevo says became of it: 'delivered', 'bounced', 'deferred' — or
-- null when it has no answer yet, which only stamps the check.
create or replace function public.record_email_delivery(p_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is not null and p_status not in ('delivered', 'bounced', 'deferred') then
    raise exception 'not a delivery status: %', p_status using errcode = '22023';
  end if;
  update public.email_outbox
     set delivery_status = coalesce(p_status, delivery_status), delivery_checked_at = now()
   where id = p_id and status = 'sent';
  if not found then
    return false;
  end if;
  if p_status in ('delivered', 'bounced') then
    update public.compliance_notices
       set delivery_status = p_status, delivery_checked_at = now()
     where email_id = p_id;
  end if;
  return true;
end;
$$;

-- ── Housekeeping ────────────────────────────────────────────────────────────

-- Outbox rows hold addresses and names; after 90 days they have done their
-- job (NDPA data minimisation). The compliance log is kept three years.
create or replace function public.purge_email_records()
returns integer
language sql
security definer
set search_path = ''
as $$
  with outbox as (
    delete from public.email_outbox
     where status in ('sent', 'skipped', 'failed') and created_at < now() - interval '90 days'
    returning 1
  ), notices as (
    delete from public.compliance_notices where sent_at < now() - interval '3 years'
    returning 1
  )
  select ((select count(*) from outbox) + (select count(*) from notices))::integer
$$;

revoke all on function public.is_reserved_email(text) from public, anon, authenticated;
revoke all on function public.queue_email(text, text, uuid, text, jsonb, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.email_for_domain_event() from public, anon, authenticated, service_role;
revoke all on function public.email_for_paid_order() from public, anon, authenticated, service_role;
revoke all on function public.email_for_sent_refund() from public, anon, authenticated, service_role;
revoke all on function public.enqueue_expiry_notices() from public, anon, authenticated, service_role;
revoke all on function public.enqueue_undelegated_nudges() from public, anon, authenticated, service_role;
revoke all on function public.purge_email_records() from public, anon, authenticated, service_role;

revoke all on function public.note_sign_in(uuid, text) from public, anon, authenticated;
revoke all on function public.queue_account_email(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_emails(text, boolean, integer) from public, anon, authenticated;
revoke all on function public.mark_email_sent(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_email_failed(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.mark_email_skipped(uuid, text, text) from public, anon, authenticated;
revoke all on function public.emails_for_delivery_check(integer) from public, anon, authenticated;
revoke all on function public.record_email_delivery(uuid, text) from public, anon, authenticated;
grant execute on function public.note_sign_in(uuid, text) to service_role;
grant execute on function public.queue_account_email(uuid, text) to service_role;
grant execute on function public.claim_emails(text, boolean, integer) to service_role;
grant execute on function public.mark_email_sent(uuid, text, text, text) to service_role;
grant execute on function public.mark_email_failed(uuid, text, text, boolean) to service_role;
grant execute on function public.mark_email_skipped(uuid, text, text) to service_role;
grant execute on function public.emails_for_delivery_check(integer) to service_role;
grant execute on function public.record_email_delivery(uuid, text) to service_role;

-- 08:05 WAT daily: the day's ERRP notices and nudges. 03:41 UTC: housekeeping.
select cron.schedule('email-notices', '5 7 * * *',
  'select public.enqueue_expiry_notices(); select public.enqueue_undelegated_nudges();');
select cron.schedule('purge-email-records', '41 3 * * *', 'select public.purge_email_records()');

-- ── Alerts (FR-NT3) ─────────────────────────────────────────────────────────
-- The conditions of migration 27, and three about email.
CREATE OR REPLACE FUNCTION public.current_alert_conditions(p_test_mode boolean)
 RETURNS TABLE(key text, severity text, kind text, summary text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- A job whose outcome is unknown with retries spent (I2).
  select 'job:' || j.id,
         'critical',
         'job_needs_attention',
         format('%s of %s%s needs a person (%s)',
                case j.kind::text
                  when 'register_domain' then 'Registration'
                  when 'renew_domain' then 'Renewal'
                  when 'transfer_domain' then 'Transfer'
                  when 'set_transfer_lock' then 'Transfer lock change'
                  when 'set_privacy' then 'Privacy change'
                  when 'update_contacts' then 'Contact change'
                  else 'Nameserver change'
                end,
                d.domain_name,
                coalesce(', order ' || o.order_number, ''),
                coalesce(j.last_error_code, 'no code'))
    from public.jobs j
    join public.domains d on d.id = j.domain_id
    left join public.order_items oi on oi.id = j.order_item_id
    left join public.orders o on o.id = oi.order_id
   where j.test_mode = p_test_mode and j.status = 'needs_attention'

  union all
  -- I5: paid, and not settled in time.
  select 'order_stuck:' || o.id,
         'critical',
         'order_stuck',
         format('Order %s was paid %s minutes ago and is still %s',
                o.order_number, floor(extract(epoch from now() - o.paid_at) / 60), o.status)
    from public.orders o
    cross join public.ops_settings s
   where o.test_mode = p_test_mode
     and o.status in ('paid', 'provisioning')
     and o.paid_at < now() - make_interval(mins => s.stuck_order_minutes)
     -- A transfer waits days for the other registrar; only other lines are late (migration 26).
     and exists (
       select 1 from public.order_items oi2
        where oi2.order_id = o.id
          and oi2.status in ('pending', 'provisioning')
          and not (oi2.item_type = 'transfer' and exists (
            select 1 from public.domains d2
             where d2.order_item_id = oi2.id and d2.local_status = 'transfer_pending'))
     )

  union all
  -- Refunds a person must look at, or approve.
  select 'refund:' || r.id,
         case when r.status = 'held' then 'warning' else 'critical' end,
         'refund_' || r.status,
         format('Refund of ₦%s for order %s%s is %s%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number,
                coalesce(' (' || oi.domain || ')', ''),
                replace(r.status::text, '_', ' '),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
    left join public.order_items oi on oi.id = r.order_item_id
   where r.test_mode = p_test_mode and r.status in ('held', 'failed', 'needs_attention')

  union all
  -- A refund that should have gone out 30 minutes ago: is the worker running?
  select 'refund_overdue:' || r.id,
         'critical',
         'refund_overdue',
         format('Refund of ₦%s for order %s has waited %s minutes to be sent%s',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.run_after) / 60),
                coalesce(' — ' || r.last_error_code, ''))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status in ('queued', 'sending')
     and r.run_after < now() - interval '30 minutes'

  union all
  -- Accepted by Flutterwave but not completed after ten days.
  select 'refund_slow:' || r.id,
         'warning',
         'refund_slow',
         format('Refund of ₦%s for order %s was sent %s days ago and has not completed',
                to_char(r.amount_kobo / 100.0, 'FM999,999,999,990.00'),
                o.order_number, floor(extract(epoch from now() - r.submitted_at) / 86400))
    from public.refunds r
    join public.orders o on o.id = r.order_id
   where r.test_mode = p_test_mode
     and r.status = 'submitted'
     and r.submitted_at < now() - interval '10 days'

  union all
  -- Money that arrived but could not be applied, or a refund that could not be queued.
  select 'incident:' || i.id,
         'critical',
         'payment_' || i.kind,
         format('Payment incident: %s%s',
                replace(i.kind, '_', ' '),
                coalesce(', order ' || o.order_number, ''))
    from public.payment_incidents i
    left join public.orders o on o.id = i.order_id
   where i.test_mode = p_test_mode and i.resolved_at is null

  union all
  -- The registry disagrees with us (§13.5).
  select 'drift:' || g.id,
         case when g.kind in ('supplier_may_renew', 'unknown_domain') then 'warning' else 'critical' end,
         'drift_' || g.kind,
         format('Registry check: %s — %s', g.domain_name, replace(g.kind, '_', ' '))
    from public.registry_drift g
   where g.test_mode = p_test_mode and g.resolved_at is null

  union all
  -- The registry has not been read successfully for three hours.
  select 'reconcile_stale:' || p_test_mode::text,
         'warning',
         'reconcile_stale',
         'The registry has not been reconciled successfully for over three hours'
   where exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode and r.started_at > now() - interval '7 days'
         )
     and not exists (
           select 1 from public.reconcile_runs r
            where r.test_mode = p_test_mode
              and r.finished_at > now() - interval '3 hours'
              and r.error is null
         )

  union all
  -- FR-FLOAT-2, simplified: checkout refuses orders the float cannot cover.
  select 'float_low:' || p_test_mode::text,
         'warning',
         'float_low',
         format('Supplier balance is $%s, below the $%s alert level. Checkout refuses orders it cannot cover.',
                to_char(b.balance_usd, 'FM999,999,990.00'), to_char(s.float_alert_usd, 'FM999,990.00'))
    from (
      select balance_usd, taken_at from public.supplier_balance_snapshots
       where test_mode = p_test_mode order by taken_at desc limit 1
    ) b
    cross join public.ops_settings s
   where b.taken_at > now() - interval '2 hours'
     and b.balance_usd < s.float_alert_usd

  union all
  -- The weekly catalogue sync inside the gateway (migration 27): its last run
  -- failed or was refused, or nothing has succeeded for eight days. Prices
  -- then drift from the supplier's.
  select 'catalogue_sync:' || h.name,
         'warning',
         'catalogue_sync',
         case
           when h.detail ->> 'outcome' in ('failed', 'refused')
             then format('The supplier catalogue sync %s on %s — prices are not being updated',
                         h.detail ->> 'outcome', to_char(h.beat_at, 'DD Mon HH24:MI'))
           else 'The supplier catalogue has not synced for over eight days — prices are not being updated'
         end
    from public.service_heartbeats h
   where p_test_mode = false
     and h.name = 'catalogue:production'
     and (
       h.detail ->> 'outcome' in ('failed', 'refused')
       or coalesce((h.detail ->> 'lastSuccessAt')::timestamptz, h.beat_at - interval '9 days')
          < now() - interval '8 days'
     )

  union all
  -- FR-NT3: an ERRP notice that bounced is a compliance failure — the
  -- registrant must be reached another way. Raised for three days.
  select 'notice_bounced:' || c.id,
         'critical',
         'compliance_notice_bounced',
         format('The %s expiry notice for %s bounced — reach the registrant another way',
                case c.notice_type when 'errp_pre_35' then 'one-month'
                                   when 'errp_pre_7' then 'one-week'
                                   else 'after-expiry' end,
                c.domain_name)
    from public.compliance_notices c
    join public.email_outbox e on e.id = c.email_id
   where e.test_mode = p_test_mode
     and c.delivery_status = 'bounced'
     and c.delivery_checked_at > now() - interval '3 days'

  union all
  -- An email that could not be sent at all (migration 31).
  select 'email_failed:' || e.id,
         case when e.category = 'transactional' then 'warning' else 'critical' end,
         'email_failed',
         format('A %s email (%s%s) could not be sent: %s',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                coalesce(e.last_error, 'no reason given'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'failed'
     and e.updated_at > now() - interval '3 days'

  union all
  -- Emails not sent after half an hour: the gateway's sender is not running,
  -- has no Brevo key, or Brevo is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and BREVO_API_KEY',
                count(*))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status in ('pending', 'sending')
     and e.created_at < now() - interval '30 minutes'
  having count(*) > 0
$function$;
