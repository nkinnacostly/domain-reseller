-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 48: MyDomainsHub Mail — the rest of the v1 API (docs/MAIL-SPEC.md
-- §3.1, §6, MR3, MR7): batches, scheduling and cancelling, the email log,
-- and API keys over the API.
--
--   enqueue_email     — (replaced) takes `scheduled_at`: at most 72 hours
--                       ahead; a moment already past means now. The email
--                       waits in the queue with next_attempt_at at that
--                       moment, so claim_sends (unchanged) takes it only
--                       when it is due. It counts against the caps on the
--                       day it is queued (reserve_send, unchanged).
--   enqueue_batch     — POST /emails/batch: up to 100 emails, each through
--                       enqueue_email, all or none (one subtransaction); an
--                       Idempotency-Key covers the whole batch for 24 hours.
--   reschedule_email  — PATCH /emails/{id}: an email still waiting in the
--                       queue, never tried, moves to another moment.
--   cancel_email      — POST /emails/{id}/cancel: the same emails only; the
--                       reservation is given back and the body deleted at
--                       once (MR3: nothing kept that will not be sent).
--   get_email         — (replaced) the same answer plus canceled_at.
--   list_emails       — GET /emails (the API, by the key's account) and
--   account_emails      the dashboard's log (as the member): one page of
--                       the account's emails, newest first, by id, status,
--                       exact recipient (to, cc or bcc), tag, subject text
--                       and date, with a cursor for the next page.
--   api_list_keys     — GET/POST/DELETE /api-keys, for a full-access key of
--   api_create_key      the same account; creating and revoking are written
--   api_revoke_key      to the account's security log as the API's doing.
--
-- No function here sends, reserves outside reserve_send, or touches a
-- body except to delete it. Every function is revoked from public, anon,
-- authenticated and service_role, then granted to exactly one role (or
-- none); supabase/tests/mail_api.sql and mail_sending.sql check 16 hold it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Batches and their Idempotency-Key ────────────────────────────────────
-- Only a batch sent with a key is kept, and only to answer a replay: the ids
-- it queued, for 24 hours. RLS on, no policy, no grant: functions only.
create table mail.email_batches (
  id               bigint generated always as identity primary key,
  account_id       uuid not null references mail.accounts (id) on delete cascade,
  api_key_id       uuid references mail.api_keys (id) on delete set null,
  idempotency_key  text not null check (char_length(idempotency_key) <= 256 and idempotency_key ~ '^[\x21-\x7e]+$'),
  request_hash     text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  email_ids        uuid[] not null check (cardinality(email_ids) between 1 and 100),
  created_at       timestamptz not null default now()
);
create unique index email_batches_idempotency on mail.email_batches (account_id, idempotency_key);

-- ── 2. Helpers (no API role may call them) ──────────────────────────────────

-- Every recipient's address, lower-cased: what "exact recipient" searches.
create function mail.recipient_addresses(p_to text[], p_cc text[], p_bcc text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array(select mail.address_of(m)
                 from unnest(coalesce(p_to, '{}') || coalesce(p_cc, '{}') || coalesce(p_bcc, '{}')) m)
$$;

create index emails_recipients on mail.emails
  using gin (mail.recipient_addresses(to_addresses, cc_addresses, bcc_addresses));

-- An ISO 8601 moment with its zone, or null — never an exception.
create function mail.as_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(p_value, '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|z|[+-]\d{2}(:?\d{2})?)$' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

-- A moment as the API shows it: UTC, to the microsecond, `Z`. Also what a
-- cursor carries, so it casts back to exactly the same moment.
create function mail.utc_text(p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- One email as the API answers it: status and times, never a body (MR3).
create function mail.email_view(p_email mail.emails)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'id', p_email.public_id, 'from', p_email.from_address, 'to', to_jsonb(p_email.to_addresses),
           'cc', to_jsonb(p_email.cc_addresses), 'bcc', to_jsonb(p_email.bcc_addresses),
           'reply_to', to_jsonb(p_email.reply_to), 'subject', p_email.subject, 'tags', p_email.tags,
           'status', p_email.status, 'status_reason', p_email.status_reason,
           'created_at', mail.utc_text(p_email.created_at), 'scheduled_at', mail.utc_text(p_email.scheduled_at),
           'sent_at', mail.utc_text(p_email.sent_at), 'delivered_at', mail.utc_text(p_email.delivered_at),
           'bounced_at', mail.utc_text(p_email.bounced_at), 'complained_at', mail.utc_text(p_email.complained_at),
           'failed_at', mail.utc_text(p_email.failed_at), 'canceled_at', mail.utc_text(p_email.canceled_at),
           'last_event', p_email.last_event, 'last_event_at', mail.utc_text(p_email.last_event_at))
$$;

-- ── 3. Queueing, with scheduled_at ──────────────────────────────────────────
-- Migration 44's function, with one addition: p_email.scheduled_at. Every
-- other line is as it was.
create or replace function mail.enqueue_email(p_account_id uuid, p_api_key_id uuid, p_email jsonb, p_payload jsonb,
                                              p_idempotency_key text default null, p_request_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from    text;
  v_to      text[];
  v_cc      text[];
  v_bcc     text[];
  v_reply   text[];
  v_all     text[];
  v_subject text;
  v_tags    jsonb;
  v_headers jsonb;
  v_attach  jsonb;
  v_size    integer;
  v_prior   mail.emails;
  v_gate    jsonb;
  v_id      bigint;
  v_public  uuid;
  v_status  text;
  v_sched   timestamptz;
  v_send_at timestamptz;
begin
  if p_account_id is null or jsonb_typeof(p_email) is distinct from 'object'
     or jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  if (p_idempotency_key is null) <> (p_request_hash is null)
     or coalesce(p_idempotency_key, 'x') !~ '^[\x21-\x7e]+$' or char_length(p_idempotency_key) > 256
     or coalesce(p_request_hash, repeat('0', 64)) !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'idempotency_key');
  end if;

  v_from := p_email ->> 'from';
  v_to := mail.text_array(p_email -> 'to');
  v_cc := mail.text_array(p_email -> 'cc');
  v_bcc := mail.text_array(p_email -> 'bcc');
  v_reply := mail.text_array(p_email -> 'reply_to');
  v_subject := p_email ->> 'subject';
  v_tags := coalesce(p_email -> 'tags', '[]'::jsonb);
  v_headers := coalesce(p_payload -> 'headers', '{}'::jsonb);
  v_attach := coalesce(p_payload -> 'attachments', '[]'::jsonb);
  if not mail.is_mailbox(v_from) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'from');
  end if;
  if v_to is null or v_cc is null or v_bcc is null or v_reply is null or cardinality(v_to) < 1
     or cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 50 or cardinality(v_reply) > 50
     or exists (select 1 from unnest(v_to || v_cc || v_bcc || v_reply) m where not mail.is_mailbox(m)) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients');
  end if;
  if v_subject is null or char_length(v_subject) not between 1 and 998 or v_subject ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'subject');
  end if;
  if jsonb_typeof(v_tags) <> 'array' or jsonb_typeof(v_headers) <> 'object' or jsonb_typeof(v_attach) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  if coalesce(p_payload ->> 'html', '') = '' and coalesce(p_payload ->> 'text', '') = '' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
  end if;
  -- §3.1: scheduled at most 72 hours ahead (five minutes' grace for clocks);
  -- a moment already past is now, so a retried request still sends.
  if jsonb_typeof(p_email -> 'scheduled_at') is not null and jsonb_typeof(p_email -> 'scheduled_at') <> 'null' then
    v_sched := case when jsonb_typeof(p_email -> 'scheduled_at') = 'string'
                    then mail.as_timestamptz(p_email ->> 'scheduled_at') end;
    if v_sched is null or v_sched > now() + interval '72 hours 5 minutes' then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'scheduled_at');
    end if;
  end if;
  v_send_at := greatest(coalesce(v_sched, now()), now());
  -- A backstop behind the app's own limit: what PostgREST carried, at most.
  v_size := octet_length(p_payload::text);
  if v_size > 8 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'size');
  end if;
  -- Each recipient once: the caps, the budget and SES all count recipients.
  v_all := array(select distinct mail.address_of(m) from unnest(v_to || v_cc || v_bcc) m);
  if cardinality(v_all) <> cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'recipients', 'reason', 'duplicate');
  end if;

  -- One account at a time from here: the replay check and the reservation
  -- see each other's writes (reserve_send takes the same lock).
  perform 1 from mail.accounts where id = p_account_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;

  if p_idempotency_key is not null then
    select * into v_prior from mail.emails
     where account_id = p_account_id and idempotency_key = p_idempotency_key;
    if v_prior.id is not null then
      if v_prior.created_at > now() - interval '24 hours' then
        if v_prior.request_hash = p_request_hash then
          return jsonb_build_object('ok', true, 'id', v_prior.public_id, 'status', v_prior.status,
                                    'replayed', true);
        end if;
        return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
      end if;
      -- Older than a day: the key is free again.
      update mail.emails set idempotency_key = null, request_hash = null, updated_at = now()
       where id = v_prior.id;
    end if;
  end if;

  v_gate := mail.reserve_send(p_account_id, p_api_key_id, v_from, v_all);
  if not coalesce((v_gate ->> 'ok')::boolean, false) and v_gate ->> 'code' is distinct from 'suppressed' then
    return v_gate;
  end if;
  v_status := case when (v_gate ->> 'ok')::boolean then 'queued' else 'suppressed' end;

  insert into mail.emails (account_id, api_key_id, domain_id, from_address, to_addresses, cc_addresses,
                           bcc_addresses, reply_to, subject, tags, status, status_reason, idempotency_key,
                           request_hash, reserved_on, reserved_hour, scheduled_at, next_attempt_at)
  values (p_account_id, p_api_key_id, (v_gate ->> 'domainId')::uuid, v_from, v_to, v_cc, v_bcc, v_reply,
          v_subject, v_tags, v_status, case when v_status = 'suppressed' then 'suppressed' end,
          p_idempotency_key, p_request_hash,
          (v_gate ->> 'reservedOn')::date, (v_gate ->> 'reservedHour')::timestamptz, v_send_at, v_send_at)
  returning id, public_id into v_id, v_public;
  if v_status = 'queued' then
    insert into mail.email_payloads (email_id, html, text, headers, attachments, size_bytes)
    values (v_id, nullif(p_payload ->> 'html', ''), nullif(p_payload ->> 'text', ''), v_headers, v_attach, v_size);
  end if;
  return jsonb_build_object('ok', true, 'id', v_public, 'status', v_status, 'replayed', false);
end;
$$;

-- ── 4. A batch: all or none ─────────────────────────────────────────────────
-- p_emails: [{ email, payload }, …], 1 to 100, each as enqueue_email takes
-- them. The first refusal undoes every email queued before it (their rows,
-- bodies and reservations: one subtransaction) and is answered with its
-- `index`. A suppressed recipient is not a refusal: that email is kept as
-- `suppressed`, as a single send keeps it.
create function mail.enqueue_batch(p_account_id uuid, p_api_key_id uuid, p_emails jsonb,
                                   p_idempotency_key text default null, p_request_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior   mail.email_batches;
  v_item    record;
  v_answer  jsonb;
  v_refusal jsonb;
  v_ids     uuid[] := '{}';
begin
  if p_account_id is null or jsonb_typeof(p_emails) is distinct from 'array'
     or jsonb_array_length(p_emails) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'emails');
  end if;
  if (p_idempotency_key is null) <> (p_request_hash is null)
     or coalesce(p_idempotency_key, 'x') !~ '^[\x21-\x7e]+$' or char_length(p_idempotency_key) > 256
     or coalesce(p_request_hash, repeat('0', 64)) !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'idempotency_key');
  end if;

  -- The account's lock first: a replay racing its original waits for it.
  perform 1 from mail.accounts where id = p_account_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;

  if p_idempotency_key is not null then
    delete from mail.email_batches
     where account_id = p_account_id and created_at <= now() - interval '24 hours';
    select * into v_prior from mail.email_batches
     where account_id = p_account_id and idempotency_key = p_idempotency_key;
    if v_prior.id is not null then
      if v_prior.request_hash = p_request_hash then
        return jsonb_build_object('ok', true, 'ids', to_jsonb(v_prior.email_ids), 'replayed', true);
      end if;
      return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
    end if;
  end if;

  begin
    for v_item in select e.value, e.ordinality - 1 as index
                    from jsonb_array_elements(p_emails) with ordinality e order by e.ordinality loop
      if jsonb_typeof(v_item.value) is distinct from 'object' then
        v_answer := jsonb_build_object('ok', false, 'code', 'validation', 'field', 'body');
      else
        v_answer := mail.enqueue_email(p_account_id, p_api_key_id, v_item.value -> 'email', v_item.value -> 'payload');
      end if;
      if not coalesce((v_answer ->> 'ok')::boolean, false) then
        -- PL/pgSQL variables outlive the rollback below; the rows do not.
        v_refusal := v_answer || jsonb_build_object('index', v_item.index);
        raise exception 'mail.enqueue_batch: email % refused', v_item.index using errcode = 'MB301';
      end if;
      v_ids := v_ids || (v_answer ->> 'id')::uuid;
    end loop;
  exception when sqlstate 'MB301' then
    return v_refusal;
  end;

  if p_idempotency_key is not null then
    insert into mail.email_batches (account_id, api_key_id, idempotency_key, request_hash, email_ids)
    values (p_account_id, p_api_key_id, p_idempotency_key, p_request_hash, v_ids);
  end if;
  return jsonb_build_object('ok', true, 'ids', to_jsonb(v_ids), 'replayed', false);
end;
$$;

-- ── 5. Reading back ─────────────────────────────────────────────────────────

-- GET /emails/{id}: migration 44's answer, with canceled_at.
create or replace function mail.get_email(p_account_id uuid, p_public_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select mail.email_view(e)
    from mail.emails e
   where e.account_id = p_account_id and e.public_id = p_public_id
$$;

-- One page of an account's log, newest first by (created_at, public_id).
-- p_filters, every key optional, every value a string:
--   id, status, to (an address: exact, in to, cc or bcc), tag_name and
--   tag_value, subject (contained, any case), created_after (inclusive)
--   and created_before (exclusive).
-- An unknown key, or a value of the wrong shape, is refused — never ignored.
-- Answers {ok, data[], hasMore, next: {at, id} | null}.
create function mail.email_page(p_account_id uuid, p_filters jsonb, p_cursor_at timestamptz,
                                p_cursor_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_filters  jsonb := coalesce(p_filters, '{}'::jsonb);
  v_id       uuid;
  v_status   text;
  v_to       text;
  v_tag      jsonb;
  v_subject  text;
  v_after    timestamptz;
  v_before   timestamptz;
  v_limit    integer := coalesce(p_limit, 20);
  v_row      mail.emails;
  v_n        integer := 0;
  v_more     boolean := false;
  v_data     jsonb := '[]'::jsonb;
  v_last_at  timestamptz;
  v_last_id  uuid;
begin
  if jsonb_typeof(v_filters) <> 'object'
     or exists (select 1 from jsonb_each(v_filters) f
                 where f.key not in ('id', 'status', 'to', 'tag_name', 'tag_value', 'subject',
                                     'created_after', 'created_before')
                    or jsonb_typeof(f.value) <> 'string') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'filters');
  end if;
  if v_limit not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'limit');
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'cursor');
  end if;

  if v_filters ? 'id' then
    if v_filters ->> 'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'id');
    end if;
    v_id := (v_filters ->> 'id')::uuid;
  end if;
  if v_filters ? 'status' then
    v_status := v_filters ->> 'status';
    if v_status not in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed',
                        'suppressed', 'canceled') then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'status');
    end if;
  end if;
  if v_filters ? 'to' then
    v_to := lower(btrim(v_filters ->> 'to'));
    if char_length(v_to) > 320 or v_to !~ '^[^@\s<>]+@[^@\s<>]+$' then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'to');
    end if;
  end if;
  if v_filters ? 'tag_value' and not v_filters ? 'tag_name' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'tag');
  end if;
  if v_filters ? 'tag_name' then
    -- SES's rule for tags, at most 256 (PostgreSQL's regex repeats stop at 255).
    if v_filters ->> 'tag_name' !~ '^[A-Za-z0-9_-]+$' or char_length(v_filters ->> 'tag_name') > 256
       or coalesce(v_filters ->> 'tag_value', 'x') !~ '^[A-Za-z0-9_-]+$'
       or char_length(v_filters ->> 'tag_value') > 256 then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'tag');
    end if;
    v_tag := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
               'name', v_filters ->> 'tag_name', 'value', v_filters ->> 'tag_value')));
  end if;
  if v_filters ? 'subject' then
    v_subject := btrim(v_filters ->> 'subject');
    if char_length(v_subject) not between 1 and 200 then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'subject');
    end if;
    -- The text is matched as written: % and _ are not wildcards here.
    v_subject := '%' || replace(replace(replace(v_subject, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if v_filters ? 'created_after' then
    v_after := mail.as_timestamptz(v_filters ->> 'created_after');
    if v_after is null then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'created_after');
    end if;
  end if;
  if v_filters ? 'created_before' then
    v_before := mail.as_timestamptz(v_filters ->> 'created_before');
    if v_before is null then
      return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'created_before');
    end if;
  end if;

  for v_row in
    select e.* from mail.emails e
     where e.account_id = p_account_id
       and (v_id is null or e.public_id = v_id)
       and (v_status is null or e.status = v_status)
       and (v_to is null
            or mail.recipient_addresses(e.to_addresses, e.cc_addresses, e.bcc_addresses) @> array[v_to])
       and (v_tag is null or e.tags @> v_tag)
       and (v_subject is null or e.subject ilike v_subject)
       and (v_after is null or e.created_at >= v_after)
       and (v_before is null or e.created_at < v_before)
       and (p_cursor_at is null or (e.created_at, e.public_id) < (p_cursor_at, p_cursor_id))
     order by e.created_at desc, e.public_id desc
     limit v_limit + 1
  loop
    v_n := v_n + 1;
    if v_n > v_limit then
      v_more := true;
      exit;
    end if;
    v_data := v_data || jsonb_build_array(mail.email_view(v_row));
    v_last_at := v_row.created_at;
    v_last_id := v_row.public_id;
  end loop;

  return jsonb_build_object(
    'ok', true, 'data', v_data, 'hasMore', v_more,
    'next', case when v_more then jsonb_build_object('at', mail.utc_text(v_last_at), 'id', v_last_id) end);
end;
$$;

-- GET /emails: by the API key's account (the API checked the key).
create function mail.list_emails(p_account_id uuid, p_filters jsonb default '{}', p_cursor_at timestamptz default null,
                                 p_cursor_id uuid default null, p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select mail.email_page(p_account_id, p_filters, p_cursor_at, p_cursor_id, p_limit)
$$;

-- The dashboard's log: any member of the account, as themselves.
create function mail.account_emails(p_account_id uuid, p_filters jsonb default '{}',
                                    p_cursor_at timestamptz default null, p_cursor_id uuid default null,
                                    p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if mail.caller_role(p_account_id) is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return mail.email_page(p_account_id, p_filters, p_cursor_at, p_cursor_id, p_limit);
end;
$$;

-- ── 6. Changing a queued email ──────────────────────────────────────────────
-- Only an email still waiting: queued and never tried. One that a worker has
-- tried may have reached SES (a timeout is unknown, not failed), so it is no
-- longer ours to move or cancel; it reads as `sending`.

create function mail.reschedule_email(p_account_id uuid, p_public_id uuid, p_scheduled_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email mail.emails;
  v_at    timestamptz;
begin
  if p_scheduled_at is null or p_scheduled_at > now() + interval '72 hours 5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'scheduled_at');
  end if;
  -- Waits for a claim in progress, then reads the row as it left it.
  select * into v_email from mail.emails
   where account_id = p_account_id and public_id = p_public_id
     for update;
  if v_email.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_email.status <> 'queued' or v_email.attempts > 0 then
    return jsonb_build_object('ok', false, 'code', 'not_pending',
                              'status', case when v_email.status = 'queued' then 'sending' else v_email.status end);
  end if;
  v_at := greatest(p_scheduled_at, now());
  update mail.emails set scheduled_at = v_at, next_attempt_at = v_at, updated_at = now()
   where id = v_email.id;
  return jsonb_build_object('ok', true, 'id', v_email.public_id, 'status', 'queued',
                            'scheduledAt', mail.utc_text(v_at));
end;
$$;

create function mail.cancel_email(p_account_id uuid, p_public_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email mail.emails;
begin
  select * into v_email from mail.emails
   where account_id = p_account_id and public_id = p_public_id
     for update;
  if v_email.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_email.status = 'canceled' then
    return jsonb_build_object('ok', true, 'id', v_email.public_id, 'status', 'canceled',
                              'scheduledAt', mail.utc_text(v_email.scheduled_at), 'already', true);
  end if;
  if v_email.status <> 'queued' or v_email.attempts > 0 then
    return jsonb_build_object('ok', false, 'code', 'not_pending',
                              'status', case when v_email.status = 'queued' then 'sending' else v_email.status end);
  end if;
  -- The caps and the shared budget get its recipients back; the body goes now.
  perform mail.release_reservation(v_email.id);
  delete from mail.email_payloads where email_id = v_email.id;
  update mail.emails
     set status = 'canceled', status_reason = 'canceled', canceled_at = now(), updated_at = now()
   where id = v_email.id;
  return jsonb_build_object('ok', true, 'id', v_email.public_id, 'status', 'canceled',
                            'scheduledAt', mail.utc_text(v_email.scheduled_at));
end;
$$;

-- ── 7. API keys over the API (§6: full-access keys only) ────────────────────
-- p_actor_key_id is the key the request came with; SQL asks again that it is
-- live, full-access and this account's. Keys made here have no user behind
-- them: the security log says `api`, and which key did it.

create function mail.api_list_keys(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'keys', coalesce(jsonb_agg(jsonb_build_object(
           'id', k.id, 'name', k.name, 'prefix', k.prefix, 'permission', k.permission,
           'domainId', k.domain_id, 'createdAt', mail.utc_text(k.created_at),
           'lastUsedAt', mail.utc_text(k.last_used_at))
           order by k.created_at desc, k.id), '[]'::jsonb))
    from mail.api_keys k
   where k.account_id = p_account_id and k.revoked_at is null
$$;

-- Whether this key may manage the account's keys.
create function mail.is_full_key(p_account_id uuid, p_key_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from mail.api_keys k
                  where k.id = p_key_id and k.account_id = p_account_id
                    and k.revoked_at is null and k.permission = 'full')
$$;

create function mail.api_create_key(p_account_id uuid, p_actor_key_id uuid, p_name text, p_permission text,
                                    p_prefix text, p_key_hash text, p_domain_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_actor text;
  v_key   mail.api_keys;
begin
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state is null or not mail.is_full_key(p_account_id, p_actor_key_id) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if p_permission is null or p_permission not in ('full', 'sending') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'permission');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'name');
  end if;
  if coalesce(p_prefix, '') !~ '^mdh_live_[A-Za-z0-9]{4}$' or coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'key');
  end if;
  if p_domain_id is not null and (p_permission <> 'sending' or not exists (
       select 1 from mail.domains d
        where d.id = p_domain_id and d.account_id = p_account_id and d.status <> 'removed')) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'domain');
  end if;

  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, domain_id)
  values (p_account_id, btrim(p_name), p_prefix, p_key_hash, p_permission, p_domain_id)
  returning * into v_key;
  select k.prefix into v_actor from mail.api_keys k where k.id = p_actor_key_id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (p_account_id, 'api', 'key.created', v_key.id::text,
          jsonb_build_object('prefix', v_key.prefix, 'permission', v_key.permission,
                             'byKeyId', p_actor_key_id, 'byKeyPrefix', v_actor));
  return jsonb_build_object('ok', true, 'key', jsonb_build_object(
    'id', v_key.id, 'name', v_key.name, 'prefix', v_key.prefix, 'permission', v_key.permission,
    'domainId', v_key.domain_id, 'createdAt', mail.utc_text(v_key.created_at), 'lastUsedAt', null));
end;
$$;

create function mail.api_revoke_key(p_account_id uuid, p_actor_key_id uuid, p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key   mail.api_keys;
  v_actor text;
begin
  if not mail.is_full_key(p_account_id, p_actor_key_id) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into v_key from mail.api_keys
   where id = p_key_id and account_id = p_account_id
     for update;
  if v_key.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_key.revoked_at is not null then
    return jsonb_build_object('ok', true, 'keyId', v_key.id, 'already', true);
  end if;
  update mail.api_keys set revoked_at = now() where id = v_key.id;
  select k.prefix into v_actor from mail.api_keys k where k.id = p_actor_key_id;
  insert into mail.account_audit_log (account_id, actor, action, target, detail)
  values (p_account_id, 'api', 'key.revoked', v_key.id::text,
          jsonb_build_object('prefix', v_key.prefix, 'byKeyId', p_actor_key_id, 'byKeyPrefix', v_actor));
  return jsonb_build_object('ok', true, 'keyId', v_key.id);
end;
$$;

-- ── 8. Row-level security and grants ────────────────────────────────────────
alter table mail.email_batches enable row level security;   -- no policies: functions only
revoke all on mail.email_batches from public, anon, authenticated, service_role;
revoke all on all sequences in schema mail from public, anon, authenticated, service_role;

revoke all on function mail.recipient_addresses(text[], text[], text[]) from public, anon, authenticated, service_role;
revoke all on function mail.as_timestamptz(text) from public, anon, authenticated, service_role;
revoke all on function mail.utc_text(timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.email_view(mail.emails) from public, anon, authenticated, service_role;
revoke all on function mail.enqueue_email(uuid, uuid, jsonb, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.enqueue_batch(uuid, uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function mail.get_email(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.email_page(uuid, jsonb, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function mail.list_emails(uuid, jsonb, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function mail.account_emails(uuid, jsonb, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function mail.reschedule_email(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function mail.cancel_email(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.api_list_keys(uuid) from public, anon, authenticated, service_role;
revoke all on function mail.is_full_key(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.api_create_key(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function mail.api_revoke_key(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The API (apps/mail, secret key): every call scoped by the key's account.
grant execute on function mail.enqueue_email(uuid, uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function mail.enqueue_batch(uuid, uuid, jsonb, text, text) to service_role;
grant execute on function mail.get_email(uuid, uuid) to service_role;
grant execute on function mail.list_emails(uuid, jsonb, timestamptz, uuid, integer) to service_role;
grant execute on function mail.reschedule_email(uuid, uuid, timestamptz) to service_role;
grant execute on function mail.cancel_email(uuid, uuid) to service_role;
grant execute on function mail.api_list_keys(uuid) to service_role;
grant execute on function mail.api_create_key(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function mail.api_revoke_key(uuid, uuid, uuid) to service_role;
-- The dashboard's log, as the member.
grant execute on function mail.account_emails(uuid, jsonb, timestamptz, uuid, integer) to authenticated;
