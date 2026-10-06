-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 45: MyDomainsHub Mail — test accounts (docs/MAIL-SPEC.md §12).
--
-- The send path's integration tests (DB_TESTS=1) and, later, Mail's e2e
-- journey need an account that can queue an email without a real SES tenant
-- or a real domain, and that is gone again afterwards. As in the shop
-- (grant_test_admin, purge_test_orders), the helpers act only on test
-- accounts: every member an e2e-*@example.com user (`public.admin_e2e_email`).
--
--   e2e_ready_account  — marks the tenant ready and adds a verified domain
--                        under the reserved `.example` TLD; flags the account
--                        `is_e2e`.
--   e2e_purge_account  — deletes the account and everything under it, its
--                        append-only security log included.
--   claim_sends        — gains `p_account_id`: a test claims its own account's
--                        emails only, and the worker's claim (no account)
--                        never takes a test account's. No email of a test
--                        account ever reaches SES.
--
-- All three are service_role only; supabase/tests/mail_e2e.sql checks them.
-- ─────────────────────────────────────────────────────────────────────────────

alter table mail.accounts add column is_e2e boolean not null default false;

-- Whether every member of the account is an e2e test user (and it has one).
create function mail.is_e2e_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from mail.members m where m.account_id = p_account_id)
     and not exists (
       select 1 from mail.members m
         left join auth.users u on u.id = m.user_id
        where m.account_id = p_account_id
          and not coalesce(public.admin_e2e_email(u.email), false))
$$;

-- The security log stays append-only, except inside e2e_purge_account.
create or replace function mail.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('mail.e2e_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '23514';
end;
$$;

create function mail.e2e_ready_account(p_account_id uuid, p_domain text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain uuid;
begin
  if not mail.is_e2e_account(p_account_id) then
    return jsonb_build_object('ok', false, 'code', 'not_e2e');
  end if;
  -- RFC 2606's reserved TLD: never a domain anyone can send from.
  if coalesce(p_domain, '') !~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.example$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'domain');
  end if;
  update mail.accounts
     set is_e2e = true, tenant_ready_at = coalesce(tenant_ready_at, now()), ses_status = 'enabled',
         updated_at = now()
   where id = p_account_id;
  insert into mail.domains (account_id, name, status, verified_at, last_checked_at)
  values (p_account_id, p_domain, 'verified', now(), now())
  returning id into v_domain;
  return jsonb_build_object('ok', true, 'domainId', v_domain);
end;
$$;

create function mail.e2e_purge_account(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emails integer;
begin
  if not exists (select 1 from mail.accounts a where a.id = p_account_id) then
    return jsonb_build_object('ok', true, 'purged', false);
  end if;
  if not mail.is_e2e_account(p_account_id) then
    return jsonb_build_object('ok', false, 'code', 'not_e2e');
  end if;
  perform set_config('mail.e2e_purge', 'on', true);
  -- In this order: an email holds its domain and its key (on delete restrict).
  delete from mail.emails where account_id = p_account_id;
  get diagnostics v_emails = row_count;
  delete from mail.api_keys where account_id = p_account_id;
  delete from mail.domains where account_id = p_account_id;
  delete from mail.account_audit_log where account_id = p_account_id;
  delete from mail.accounts where id = p_account_id;
  perform set_config('mail.e2e_purge', 'off', true);
  return jsonb_build_object('ok', true, 'purged', true, 'emails', v_emails);
end;
$$;

-- claim_sends with an account: the same claim, for one account's emails.
drop function mail.claim_sends(text, integer, boolean);

create function mail.claim_sends(p_worker text, p_limit integer, p_paid_only boolean default false,
                                 p_account_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings mail.settings;
  v_row      record;
  v_gate     record;
  v_payload  mail.email_payloads;
  v_out      jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_worker), '') = '' or char_length(p_worker) > 100 or p_limit is null
     or p_limit not between 1 and 100 then
    raise exception 'claim_sends: a worker name and a limit of 1 to 100' using errcode = '22023';
  end if;
  select * into v_settings from mail.settings where id;
  if v_settings.id is null then
    raise exception 'mail.settings is missing' using errcode = '55000';
  end if;

  -- Lost claims. After the last attempt the outcome stays unknown, so the
  -- reservation is kept: it may have gone out.
  update mail.emails
     set status = case when attempts >= v_settings.max_send_attempts then 'failed' else 'queued' end,
         status_reason = case when attempts >= v_settings.max_send_attempts then 'worker_lost' else status_reason end,
         failed_at = case when attempts >= v_settings.max_send_attempts then now() else failed_at end,
         claimed_by = null, claimed_at = null, next_attempt_at = now(), updated_at = now()
   where status = 'sending' and claimed_at < now() - interval '10 minutes';

  for v_row in
    select e.id, e.public_id, e.from_address, e.to_addresses, e.cc_addresses, e.bcc_addresses, e.reply_to,
           e.subject, e.tags, e.recipient_count, e.attempts, a.short_id, a.ses_tenant, a.config_set
      from mail.emails e
      join mail.accounts a on a.id = e.account_id
      join mail.plans p on p.code = a.plan_code
     where e.status = 'queued' and e.next_attempt_at <= now() and e.scheduled_at <= now()
       and (not coalesce(p_paid_only, false) or (p.price_kobo > 0 and a.state = 'active'))
       -- The worker never takes a test account's email; a test takes only its own.
       and case when p_account_id is null then not a.is_e2e else a.id = p_account_id end
     order by e.next_attempt_at, e.id
     limit p_limit
     for update of e skip locked
  loop
    select * into v_gate from mail.send_gate(v_row.id);
    if v_gate.status is not null then
      perform mail.settle_unsent(v_row.id, v_gate.status, v_gate.reason);
      continue;
    end if;
    select * into v_payload from mail.email_payloads where email_id = v_row.id;
    if v_payload.email_id is null then
      perform mail.settle_unsent(v_row.id, 'failed', 'payload_missing');
      continue;
    end if;
    update mail.emails
       set status = 'sending', claimed_by = p_worker, claimed_at = now(), attempts = attempts + 1,
           updated_at = now()
     where id = v_row.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'publicId', v_row.public_id, 'accountShortId', v_row.short_id,
      'tenant', v_row.ses_tenant, 'configurationSet', v_row.config_set,
      'from', v_row.from_address, 'to', to_jsonb(v_row.to_addresses), 'cc', to_jsonb(v_row.cc_addresses),
      'bcc', to_jsonb(v_row.bcc_addresses), 'replyTo', to_jsonb(v_row.reply_to),
      'subject', v_row.subject, 'tags', v_row.tags, 'recipientCount', v_row.recipient_count,
      'attempt', v_row.attempts + 1, 'html', v_payload.html, 'text', v_payload.text,
      'headers', v_payload.headers, 'attachments', v_payload.attachments));
  end loop;
  return v_out;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The new column is readable like the rest of accounts (migration 43 granted
-- the table, so it already is); nothing else changes for the API roles.
revoke all on function mail.is_e2e_account(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.append_only() from public, anon, authenticated, service_role;
revoke all on function mail.e2e_ready_account(uuid, text) from public, anon, authenticated, service_role;
revoke all on function mail.e2e_purge_account(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.claim_sends(text, integer, boolean, uuid) from public, anon, authenticated, service_role;

grant execute on function mail.e2e_ready_account(uuid, text) to service_role;
grant execute on function mail.e2e_purge_account(uuid) to service_role;
grant execute on function mail.claim_sends(text, integer, boolean, uuid) to service_role;
