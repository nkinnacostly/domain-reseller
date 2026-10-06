-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 48 (MyDomainsHub Mail, the v1 API), tried as the database owner
-- and, where the grant is the point, as `authenticated` and `service_role`:
-- scheduling (and the worker taking an email only when it is due),
-- rescheduling and cancelling, batches all or none with their
-- Idempotency-Key, the log's filters and cursor, get_email, API keys over
-- the API, and every new function's grant. People are made up with
-- e2e-*@example.com addresses; no email is sent. Rolled back.
--
--   supabase db query --linked -f supabase/tests/mail_api.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

create function pg_temp.mv_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
end $f$;

create function pg_temp.mv_code(p_j jsonb, p_code text, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'code') is distinct from p_code then
    raise exception '% (expected %, got %)', p_what, p_code, p_j;
  end if;
end $f$;

create function pg_temp.mv_ok(p_j jsonb, p_what text) returns void language plpgsql as $f$
begin
  if p_j is null or (p_j ->> 'ok')::boolean is not true then
    raise exception '% (expected ok, got %)', p_what, p_j;
  end if;
end $f$;

-- One email as the API hands it to SQL; p_extra is merged into `email`.
create function pg_temp.mv_item(p_from text, p_to text[], p_extra jsonb default '{}') returns jsonb
language sql as $f$
  select jsonb_build_object(
           'email', jsonb_build_object('from', p_from, 'to', to_jsonb(p_to), 'subject', 'Hello from the m48 check',
                                       'tags', '[{"name":"kind","value":"check"}]'::jsonb) || p_extra,
           'payload', '{"html":"<p>Hi</p>","text":"Hi","headers":{},"attachments":[]}'::jsonb)
$f$;

create function pg_temp.mv_send(p_account uuid, p_key uuid, p_from text, p_to text[], p_extra jsonb default '{}')
returns jsonb language plpgsql as $f$
declare
  v_item jsonb := pg_temp.mv_item(p_from, p_to, p_extra);
  v_j    jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_email(p_account, p_key, v_item -> 'email', v_item -> 'payload');
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_batch(p_account uuid, p_key uuid, p_items jsonb, p_idem text default null,
                                 p_hash text default null)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.enqueue_batch(p_account, p_key, p_items, p_idem, p_hash);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_list(p_account uuid, p_filters jsonb default '{}', p_at timestamptz default null,
                                p_id uuid default null, p_limit integer default 20)
returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.list_emails(p_account, p_filters, p_at, p_id, p_limit);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_resched(p_account uuid, p_id uuid, p_at timestamptz) returns jsonb
language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.reschedule_email(p_account, p_id, p_at);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_cancel(p_account uuid, p_id uuid) returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.cancel_email(p_account, p_id);
  execute 'reset role';
  return v_j;
end $f$;

-- The worker's claim, for this account only (migration 45): nobody else's email moves.
create function pg_temp.mv_claim(p_account uuid, p_limit integer default 50) returns jsonb language plpgsql as $f$
declare
  v_j jsonb;
begin
  execute 'set local role service_role';
  v_j := mail.claim_sends('m48-worker', p_limit, false, p_account);
  execute 'reset role';
  return v_j;
end $f$;

create function pg_temp.mv_used(p_account uuid) returns integer language sql as $f$
  select coalesce(sum(queued), 0)::integer from mail.usage_daily where account_id = p_account
$f$;

create function pg_temp.mv_ids(p_page jsonb) returns uuid[] language sql as $f$
  select coalesce(array_agg((e ->> 'id')::uuid order by o), '{}')
    from jsonb_array_elements(p_page -> 'data') with ordinality as x(e, o)
$f$;

do $$
declare
  v_tag    text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  u_o      uuid := gen_random_uuid();
  u_v      uuid := gen_random_uuid();
  u_n      uuid := gen_random_uuid();
  u_b      uuid := gen_random_uuid();
  m_o      text;
  m_v      text;
  a_acc    uuid;
  b_acc    uuid;
  d1       uuid;
  d2       uuid;
  db       uuid;
  n1       text;
  nb       text;
  k_full   uuid;
  k_send   uuid;
  k_rev    uuid;
  k_b      uuid;
  v_j      jsonb;
  v_j2     jsonb;
  v_id     uuid;
  v_id2    uuid;
  v_ids    uuid[];
  v_all    uuid[];
  v_n      integer;
  v_m      integer;
  v_at     timestamptz;
  v_row    record;
  v_want   text;
  v_expected jsonb;
  v_passed integer := 0;
begin
  m_o := 'e2e-ma-o-' || v_tag || '@example.com';
  m_v := 'e2e-ma-v-' || v_tag || '@example.com';
  insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (u_o, 'authenticated', 'authenticated', m_o, now(), now(), now()),
    (u_v, 'authenticated', 'authenticated', m_v, now(), now(), now()),
    (u_n, 'authenticated', 'authenticated', 'e2e-ma-n-' || v_tag || '@example.com', now(), now(), now()),
    (u_b, 'authenticated', 'authenticated', 'e2e-ma-b-' || v_tag || '@example.com', now(), now(), now());

  perform pg_temp.mv_as(u_o);
  a_acc := (mail.create_account('m48 A ' || v_tag) ->> 'accountId')::uuid;
  perform pg_temp.mv_as(u_b);
  b_acc := (mail.create_account('m48 B ' || v_tag) ->> 'accountId')::uuid;
  execute 'reset role';
  -- Active on Starter, so recipients need not be members.
  update mail.accounts set tenant_ready_at = now(), ses_status = 'enabled', state = 'active', plan_code = 'starter'
   where id in (a_acc, b_acc);
  insert into mail.members (account_id, user_id, role) values (a_acc, u_v, 'viewer');
  n1 := 'ma1-' || v_tag || '.example';
  nb := 'mab-' || v_tag || '.example';
  insert into mail.domains (account_id, name, status) values (a_acc, n1, 'verified') returning id into d1;
  insert into mail.domains (account_id, name, status) values (a_acc, 'ma2-' || v_tag || '.example', 'pending')
    returning id into d2;
  insert into mail.domains (account_id, name, status) values (b_acc, nb, 'verified') returning id into db;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (a_acc, 'full', 'mdh_live_full', encode(extensions.digest(v_tag || 'full', 'sha256'), 'hex'), 'full')
    returning id into k_full;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (a_acc, 'send', 'mdh_live_send', encode(extensions.digest(v_tag || 'send', 'sha256'), 'hex'), 'sending')
    returning id into k_send;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission, revoked_at) values
    (a_acc, 'revoked', 'mdh_live_rev0', encode(extensions.digest(v_tag || 'rev', 'sha256'), 'hex'), 'full', now())
    returning id into k_rev;
  insert into mail.api_keys (account_id, name, prefix, key_hash, permission) values
    (b_acc, 'b', 'mdh_live_bbbb', encode(extensions.digest(v_tag || 'b', 'sha256'), 'hex'), 'full')
    returning id into k_b;

  -- ── 1. scheduled_at (§3.1): queued for later, counted today, claimed only
  -- when due; a moment past is now; 72 hours ahead at most; malformed refused.
  v_n := pg_temp.mv_used(a_acc);
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['later@example.com'],
                         jsonb_build_object('scheduled_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')));
  perform pg_temp.mv_ok(v_j, 'FAILED 1: a scheduled send');
  v_id := (v_j ->> 'id')::uuid;
  if (select abs(extract(epoch from scheduled_at - (now() + interval '1 hour'))) from mail.emails where public_id = v_id) > 1
     or (select next_attempt_at <> scheduled_at or status <> 'queued' from mail.emails where public_id = v_id)
     or pg_temp.mv_used(a_acc) <> v_n + 1 then
    raise exception 'FAILED 1: the scheduled row is wrong, or was not counted today';
  end if;
  if jsonb_array_length(pg_temp.mv_claim(a_acc)) <> 0 then
    raise exception 'FAILED 1: an email was claimed before it was due';
  end if;
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['past@example.com'],
                         '{"scheduled_at":"2020-01-01T00:00:00Z"}');
  v_id2 := (v_j ->> 'id')::uuid;
  if (select scheduled_at from mail.emails where public_id = v_id2) <> now() then
    raise exception 'FAILED 1: a moment in the past was not now';
  end if;
  v_j := pg_temp.mv_claim(a_acc);
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,publicId}')::uuid is distinct from v_id2 then
    raise exception 'FAILED 1: the due email was not the one claimed: %', v_j;
  end if;
  -- Due once its moment comes.
  update mail.emails set scheduled_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
   where public_id = v_id;
  v_j := pg_temp.mv_claim(a_acc);
  if jsonb_array_length(v_j) <> 1 or (v_j #>> '{0,publicId}')::uuid is distinct from v_id then
    raise exception 'FAILED 1: a scheduled email was not claimed once due: %', v_j;
  end if;
  perform pg_temp.mv_ok(pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['edge@example.com'],
                          jsonb_build_object('scheduled_at', to_char((now() + interval '72 hours') at time zone 'UTC',
                                                                     'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
                        'FAILED 1: 72 hours ahead');
  perform pg_temp.mv_ok(pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['null@example.com'],
                          '{"scheduled_at":null}'), 'FAILED 1: a null scheduled_at');
  perform pg_temp.mv_code(pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['far@example.com'],
                            jsonb_build_object('scheduled_at', to_char((now() + interval '73 hours') at time zone 'UTC',
                                                                       'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
                          'validation', 'FAILED 1: 73 hours ahead');
  for v_j2 in select x from unnest(array['"tomorrow"', '"2026-10-07T10:00:00"', '1767225600', '"2026-02-30T10:00:00Z"']) x loop
    perform pg_temp.mv_code(pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['bad@example.com'],
                              jsonb_build_object('scheduled_at', v_j2)),
                            'validation', 'FAILED 1: scheduled_at ' || v_j2::text);
  end loop;
  if (pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['bad@example.com'], '{"scheduled_at":"soon"}')
        ->> 'field') <> 'scheduled_at' then
    raise exception 'FAILED 1: the refusal does not name scheduled_at';
  end if;
  v_passed := v_passed + 1;

  -- ── 2. reschedule_email: only the account's own, only while still waiting.
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['move@example.com'],
                         jsonb_build_object('scheduled_at', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')));
  v_id := (v_j ->> 'id')::uuid;
  perform pg_temp.mv_code(pg_temp.mv_resched(b_acc, v_id, now() + interval '3 hours'), 'not_found',
                          'FAILED 2: another account moved it');
  v_j := pg_temp.mv_resched(a_acc, v_id, now() + interval '3 hours');
  perform pg_temp.mv_ok(v_j, 'FAILED 2: a reschedule');
  if (select scheduled_at <> now() + interval '3 hours' or next_attempt_at <> now() + interval '3 hours'
        from mail.emails where public_id = v_id)
     or v_j ->> 'status' <> 'queued' or (v_j ->> 'scheduledAt')::timestamptz <> now() + interval '3 hours' then
    raise exception 'FAILED 2: the reschedule answered % and did not move both times', v_j;
  end if;
  perform pg_temp.mv_code(pg_temp.mv_resched(a_acc, v_id, now() + interval '73 hours'), 'validation',
                          'FAILED 2: 73 hours ahead');
  perform pg_temp.mv_code(pg_temp.mv_resched(a_acc, v_id, null), 'validation', 'FAILED 2: no moment');
  perform pg_temp.mv_code(pg_temp.mv_resched(a_acc, gen_random_uuid(), now()), 'not_found', 'FAILED 2: no such email');
  -- A moment past is now: the worker may take it at once.
  perform pg_temp.mv_ok(pg_temp.mv_resched(a_acc, v_id, now() - interval '1 day'), 'FAILED 2: to the past');
  if (select scheduled_at from mail.emails where public_id = v_id) <> now() then
    raise exception 'FAILED 2: a moment past was not now';
  end if;
  v_j := pg_temp.mv_claim(a_acc);
  if not exists (select 1 from jsonb_array_elements(v_j) e where (e ->> 'publicId')::uuid = v_id) then
    raise exception 'FAILED 2: the rescheduled email was not due: %', v_j;
  end if;
  v_j := pg_temp.mv_resched(a_acc, v_id, now() + interval '1 hour');
  perform pg_temp.mv_code(v_j, 'not_pending', 'FAILED 2: a claimed email moved');
  if v_j ->> 'status' <> 'sending' then raise exception 'FAILED 2: the claimed email said %', v_j; end if;
  -- Tried once and back in the queue: it may have reached SES, so it is not ours to move.
  update mail.emails set status = 'queued', claimed_by = null, claimed_at = null where public_id = v_id;
  v_j := pg_temp.mv_resched(a_acc, v_id, now() + interval '1 hour');
  if v_j ->> 'code' <> 'not_pending' or v_j ->> 'status' <> 'sending' then
    raise exception 'FAILED 2: a tried email moved: %', v_j;
  end if;
  v_passed := v_passed + 1;

  -- ── 3. cancel_email: the reservation given back, the body deleted at once,
  -- the same answer again; never once it has left.
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['one@example.com', 'two@example.com'],
                         jsonb_build_object('scheduled_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')));
  v_id := (v_j ->> 'id')::uuid;
  v_n := pg_temp.mv_used(a_acc);
  v_m := (select recipients from mail.send_budget_hourly where account_id = a_acc and hour = date_trunc('hour', now()));
  perform pg_temp.mv_code(pg_temp.mv_cancel(b_acc, v_id), 'not_found', 'FAILED 3: another account canceled it');
  v_j := pg_temp.mv_cancel(a_acc, v_id);
  perform pg_temp.mv_ok(v_j, 'FAILED 3: a cancel');
  if v_j ->> 'status' <> 'canceled'
     or (select status || '/' || status_reason from mail.emails where public_id = v_id) <> 'canceled/canceled'
     or (select canceled_at from mail.emails where public_id = v_id) is null
     or (select reserved_on from mail.emails where public_id = v_id) is not null
     or exists (select 1 from mail.email_payloads p join mail.emails e on e.id = p.email_id where e.public_id = v_id)
     or pg_temp.mv_used(a_acc) <> v_n - 2
     or (select recipients from mail.send_budget_hourly where account_id = a_acc and hour = date_trunc('hour', now())) <> v_m - 2 then
    raise exception 'FAILED 3: the cancel left something behind: %', v_j;
  end if;
  v_j := pg_temp.mv_cancel(a_acc, v_id);
  if (v_j ->> 'ok')::boolean is not true or (v_j ->> 'already')::boolean is not true or pg_temp.mv_used(a_acc) <> v_n - 2 then
    raise exception 'FAILED 3: a second cancel answered % or gave back twice', v_j;
  end if;
  v_j := pg_temp.mv_resched(a_acc, v_id, now());
  if v_j ->> 'code' <> 'not_pending' or v_j ->> 'status' <> 'canceled' then
    raise exception 'FAILED 3: a canceled email moved: %', v_j;
  end if;
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['gone@example.com']);
  v_id := (v_j ->> 'id')::uuid;
  perform pg_temp.mv_claim(a_acc);
  v_j := pg_temp.mv_cancel(a_acc, v_id);
  if v_j ->> 'code' <> 'not_pending' or v_j ->> 'status' <> 'sending'
     or (select status from mail.emails where public_id = v_id) <> 'sending' then
    raise exception 'FAILED 3: a claimed email was canceled: %', v_j;
  end if;
  update mail.emails set status = 'sent', claimed_by = null, claimed_at = null, sent_at = now() where public_id = v_id;
  perform pg_temp.mv_code(pg_temp.mv_cancel(a_acc, v_id), 'not_pending', 'FAILED 3: a sent email');
  perform pg_temp.mv_code(pg_temp.mv_cancel(a_acc, gen_random_uuid()), 'not_found', 'FAILED 3: no such email');
  v_passed := v_passed + 1;

  -- ── 4. enqueue_batch: in order, all or none, one Idempotency-Key for the lot.
  select count(*) into v_m from mail.emails where account_id = a_acc;
  v_n := pg_temp.mv_used(a_acc);
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(
           pg_temp.mv_item('hello@' || n1, array['b1@example.com']),
           pg_temp.mv_item('Acme <hello@' || n1 || '>', array['b2@example.com', 'b3@example.com']),
           pg_temp.mv_item('hello@' || n1, array['b4@example.com'], '{"subject":"Third"}')),
         'batch-' || v_tag, repeat('a', 64));
  perform pg_temp.mv_ok(v_j, 'FAILED 4: a batch of three');
  select array_agg(x::uuid order by o) into v_ids from jsonb_array_elements_text(v_j -> 'ids') with ordinality as t(x, o);
  if cardinality(v_ids) <> 3 or (v_j ->> 'replayed')::boolean
     or (select subject from mail.emails where public_id = v_ids[3]) <> 'Third'
     or (select recipient_count from mail.emails where public_id = v_ids[2]) <> 2
     or (select count(*) from mail.emails where account_id = a_acc) <> v_m + 3
     or (select count(*) from mail.emails where public_id = any (v_ids) and api_key_id = k_send and idempotency_key is null) <> 3
     or pg_temp.mv_used(a_acc) <> v_n + 4 then
    raise exception 'FAILED 4: the batch answered % and queued the wrong rows', v_j;
  end if;
  v_j2 := pg_temp.mv_batch(a_acc, k_send, '[]'::jsonb || pg_temp.mv_item('hello@' || n1, array['other@example.com']),
                           'batch-' || v_tag, repeat('a', 64));
  if (v_j2 ->> 'replayed')::boolean is not true or v_j2 -> 'ids' <> v_j -> 'ids'
     or (select count(*) from mail.emails where account_id = a_acc) <> v_m + 3 then
    raise exception 'FAILED 4: a replay answered % or queued again', v_j2;
  end if;
  perform pg_temp.mv_code(pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['x@example.com'])),
                                           'batch-' || v_tag, repeat('b', 64)),
                          'idempotency_conflict', 'FAILED 4: the key with another batch');
  -- The same key on another account is that account's own.
  perform pg_temp.mv_ok(pg_temp.mv_batch(b_acc, k_b, jsonb_build_array(pg_temp.mv_item('hello@' || nb, array['x@example.com'])),
                                         'batch-' || v_tag, repeat('b', 64)),
                        'FAILED 4: the same key on another account');
  -- One refusal undoes the lot, and says which.
  v_n := pg_temp.mv_used(a_acc);
  select count(*) into v_m from mail.emails where account_id = a_acc;
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(
           pg_temp.mv_item('hello@' || n1, array['c1@example.com']),
           pg_temp.mv_item('hello@' || n1, array['c2@example.com']),
           pg_temp.mv_item('hello@ma2-' || v_tag || '.example', array['c3@example.com'])));
  perform pg_temp.mv_code(v_j, 'domain_not_verified', 'FAILED 4: an unverified domain in a batch');
  if (v_j ->> 'index')::integer is distinct from 2
     or (select count(*) from mail.emails where account_id = a_acc) <> v_m or pg_temp.mv_used(a_acc) <> v_n then
    raise exception 'FAILED 4: a refused batch left % or said %', (select count(*) from mail.emails where account_id = a_acc) - v_m, v_j;
  end if;
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['c1@example.com']), 'oops'::text));
  if v_j ->> 'code' <> 'validation' or (v_j ->> 'index')::integer <> 1 or pg_temp.mv_used(a_acc) <> v_n then
    raise exception 'FAILED 4: a batch item that is not an object: %', v_j;
  end if;
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['c1@example.com'],
                                                                           '{"scheduled_at":"never"}')));
  if v_j ->> 'field' <> 'scheduled_at' or (v_j ->> 'index')::integer <> 0 then
    raise exception 'FAILED 4: a bad scheduled_at in a batch: %', v_j;
  end if;
  perform pg_temp.mv_code(pg_temp.mv_batch(a_acc, k_send, '[]'), 'validation', 'FAILED 4: an empty batch');
  perform pg_temp.mv_code(pg_temp.mv_batch(a_acc, k_send,
                            (select jsonb_agg(pg_temp.mv_item('hello@' || n1, array['m' || i || '@example.com']))
                               from generate_series(1, 101) i)),
                          'validation', 'FAILED 4: 101 emails');
  perform pg_temp.mv_code(pg_temp.mv_batch(a_acc, k_send, '{}'), 'validation', 'FAILED 4: not an array');
  perform pg_temp.mv_code(pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['x@example.com'])),
                                           'key-without-hash', null),
                          'validation', 'FAILED 4: a key without its hash');
  perform pg_temp.mv_code(pg_temp.mv_batch(gen_random_uuid(), k_send,
                                           jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['x@example.com']))),
                          'unauthorized', 'FAILED 4: no such account');
  -- A day on, the key is free again.
  update mail.email_batches set created_at = now() - interval '25 hours' where account_id = a_acc;
  perform pg_temp.mv_ok(pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['d@example.com'])),
                                         'batch-' || v_tag, repeat('c', 64)),
                        'FAILED 4: the key after 24 hours');
  if (select count(*) from mail.email_batches where account_id = a_acc) <> 1 then
    raise exception 'FAILED 4: an expired batch key was kept';
  end if;
  -- A suppressed recipient is not a refusal: that email is kept as suppressed.
  insert into mail.suppressions (account_id, address, reason, source) values (a_acc, 'sup@example.com', 'bounce', 'ses');
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(pg_temp.mv_item('hello@' || n1, array['Sup <SUP@example.com>']),
                                                           pg_temp.mv_item('hello@' || n1, array['fine@example.com'])));
  perform pg_temp.mv_ok(v_j, 'FAILED 4: a batch with a suppressed recipient');
  if (select status from mail.emails where public_id = (v_j #>> '{ids,0}')::uuid) <> 'suppressed'
     or (select status from mail.emails where public_id = (v_j #>> '{ids,1}')::uuid) <> 'queued' then
    raise exception 'FAILED 4: the suppressed email in a batch';
  end if;
  delete from mail.suppressions where account_id = a_acc;
  v_passed := v_passed + 1;

  -- ── 5. list_emails: newest first, every filter, a cursor through equal
  -- times, only the account's own, never a body; refusals for what it cannot act on.
  delete from mail.emails where account_id = a_acc;
  v_j := pg_temp.mv_batch(a_acc, k_send, jsonb_build_array(
           pg_temp.mv_item('hello@' || n1, array['p1@example.com'], '{"subject":"Your receipt 100% paid"}'),
           pg_temp.mv_item('hello@' || n1, array['p2@example.com'],
                           '{"cc":["Ada Lovelace <ADA@Example.com>"],"tags":[{"name":"kind","value":"receipt"}]}'),
           pg_temp.mv_item('hello@' || n1, array['p3@example.com'], '{"bcc":["hidden@example.com"],"subject":"Reset"}'),
           pg_temp.mv_item('hello@' || n1, array['p4@example.com'], '{"tags":[{"name":"flow","value":"signup"}]}'),
           pg_temp.mv_item('hello@' || n1, array['p5@example.com'])));
  select array_agg(x::uuid) into v_all from jsonb_array_elements_text(v_j -> 'ids') x;
  -- One older, canceled.
  v_j := pg_temp.mv_send(a_acc, k_full, 'hello@' || n1, array['old@example.com'],
                         jsonb_build_object('scheduled_at', to_char(now() + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')));
  v_id := (v_j ->> 'id')::uuid;
  perform pg_temp.mv_cancel(a_acc, v_id);
  update mail.emails set created_at = now() - interval '2 days' where public_id = v_id;
  perform pg_temp.mv_send(b_acc, k_b, 'hello@' || nb, array['p1@example.com']);

  v_j := pg_temp.mv_list(a_acc);
  perform pg_temp.mv_ok(v_j, 'FAILED 5: a plain list');
  if jsonb_array_length(v_j -> 'data') <> 6 or (v_j ->> 'hasMore')::boolean or v_j -> 'next' <> 'null'::jsonb
     or (pg_temp.mv_ids(v_j))[6] <> v_id or v_j -> 'data' -> 0 ? 'html' or v_j -> 'data' -> 0 ? 'text'
     or not (v_j -> 'data' -> 0 ?& array['id', 'from', 'to', 'status', 'created_at', 'scheduled_at', 'canceled_at'])
     or (v_j #>> '{data,0,created_at}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$' then
    raise exception 'FAILED 5: the list answered %', v_j;
  end if;
  if (pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"status":"canceled"}'))) <> array[v_id] then
    raise exception 'FAILED 5: the status filter';
  end if;
  if cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"to":"ada@example.com"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"to":"HIDDEN@example.com"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"to":"p1@example.com"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"to":"ada@example"}'))) <> 0 then
    raise exception 'FAILED 5: the exact recipient filter (to, cc, bcc; never a part)';
  end if;
  if cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"tag_name":"kind"}'))) <> 5
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"tag_name":"kind","tag_value":"receipt"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"tag_name":"flow"}'))) <> 1 then
    raise exception 'FAILED 5: the tag filter';
  end if;
  if cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"subject":"RECEIPT"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"subject":"100%"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"subject":"%"}'))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, '{"subject":"m48_check"}'))) <> 0 then
    raise exception 'FAILED 5: the subject filter (contained, any case, %% and _ as written)';
  end if;
  if cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, jsonb_build_object('created_before', mail.utc_text(now() - interval '1 day'))))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, jsonb_build_object('created_after', mail.utc_text(now()))))) <> 5
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(a_acc, jsonb_build_object('id', v_all[2])))) <> 1
     or cardinality(pg_temp.mv_ids(pg_temp.mv_list(b_acc, jsonb_build_object('id', v_all[2])))) <> 0 then
    raise exception 'FAILED 5: the date and id filters';
  end if;
  -- Five emails share one created_at: the cursor still walks each exactly once.
  v_ids := '{}';
  v_j := pg_temp.mv_list(a_acc, '{}', null, null, 2);
  v_n := 0;
  loop
    v_n := v_n + 1;
    v_ids := v_ids || pg_temp.mv_ids(v_j);
    exit when not (v_j ->> 'hasMore')::boolean or v_n > 10;
    v_j := pg_temp.mv_list(a_acc, '{}', (v_j #>> '{next,at}')::timestamptz, (v_j #>> '{next,id}')::uuid, 2);
  end loop;
  if v_n <> 3 or cardinality(v_ids) <> 6 or (select count(distinct x) from unnest(v_ids) x) <> 6
     or v_ids[6] <> v_id or v_j -> 'next' <> 'null'::jsonb then
    raise exception 'FAILED 5: the cursor walked % pages and saw %', v_n, v_ids;
  end if;
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"from":"x"}'), 'validation', 'FAILED 5: an unknown filter');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"status":1}'), 'validation', 'FAILED 5: a number');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"status":"lost"}'), 'validation', 'FAILED 5: an unknown status');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"to":"nobody"}'), 'validation', 'FAILED 5: not an address');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"tag_value":"x"}'), 'validation', 'FAILED 5: a value without a name');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"id":"42"}'), 'validation', 'FAILED 5: an id that is not one');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{"created_after":"yesterday"}'), 'validation', 'FAILED 5: a date');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{}', null, null, 101), 'validation', 'FAILED 5: 101 a page');
  perform pg_temp.mv_code(pg_temp.mv_list(a_acc, '{}', now(), null, 10), 'validation', 'FAILED 5: half a cursor');
  v_passed := v_passed + 1;

  -- ── 6. account_emails: the dashboard's log, for members only.
  perform pg_temp.mv_as(u_v);
  v_j := mail.account_emails(a_acc, '{"status":"canceled"}');
  perform pg_temp.mv_as(u_n);
  v_j2 := mail.account_emails(a_acc);
  execute 'reset role';
  if (pg_temp.mv_ids(v_j))[1] is distinct from v_id or v_j2 ->> 'code' <> 'not_found' then
    raise exception 'FAILED 6: a viewer read % and a stranger %', v_j, v_j2;
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  execute 'set local role authenticated';
  v_j := mail.account_emails(a_acc);
  execute 'reset role';
  perform pg_temp.mv_code(v_j, 'unauthorized', 'FAILED 6: nobody signed in');
  v_passed := v_passed + 1;

  -- ── 7. get_email keeps its answer and adds canceled_at; another account's is null.
  execute 'set local role service_role';
  v_j := mail.get_email(a_acc, v_id);
  v_j2 := mail.get_email(b_acc, v_id);
  execute 'reset role';
  if v_j ->> 'status' <> 'canceled' or v_j ->> 'canceled_at' is null or v_j ? 'html' or v_j2 is not null
     or not (v_j ?& array['id', 'from', 'to', 'cc', 'bcc', 'reply_to', 'subject', 'tags', 'status', 'status_reason',
                          'created_at', 'scheduled_at', 'sent_at', 'delivered_at', 'bounced_at', 'complained_at',
                          'failed_at', 'last_event', 'last_event_at']) then
    raise exception 'FAILED 7: get_email answered % and %', v_j, v_j2;
  end if;
  v_passed := v_passed + 1;

  -- ── 8. API keys over the API: a live full-access key of the account only;
  -- the log says the API did it, and which key.
  execute 'set local role service_role';
  v_j := mail.api_list_keys(a_acc);
  execute 'reset role';
  if jsonb_array_length(v_j -> 'keys') <> 2 or v_j::text like '%key_hash%' or v_j::text like '%' || k_rev || '%'
     or v_j::text like '%' || k_b || '%' then
    raise exception 'FAILED 8: the list answered %', v_j;
  end if;
  execute 'set local role service_role';
  v_j := mail.api_create_key(a_acc, k_full, '  Billing  ', 'sending', 'mdh_live_new0',
                             encode(extensions.digest(v_tag || 'new', 'sha256'), 'hex'), d1);
  execute 'reset role';
  perform pg_temp.mv_ok(v_j, 'FAILED 8: a full key makes a key');
  v_id2 := (v_j #>> '{key,id}')::uuid;
  if v_j #>> '{key,name}' <> 'Billing' or v_j #>> '{key,permission}' <> 'sending' or (v_j #>> '{key,domainId}')::uuid <> d1
     or (select created_by from mail.api_keys where id = v_id2) is not null
     or not exists (select 1 from mail.account_audit_log
                     where account_id = a_acc and action = 'key.created' and actor = 'api' and target = v_id2::text
                       and (detail ->> 'byKeyId')::uuid = k_full and detail ->> 'byKeyPrefix' = 'mdh_live_full') then
    raise exception 'FAILED 8: the new key or its log line: %', v_j;
  end if;
  execute 'set local role service_role';
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_send, 'x', 'full', 'mdh_live_new1', repeat('1', 64)),
                          'forbidden', 'FAILED 8: a sending key made a key');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_rev, 'x', 'full', 'mdh_live_new1', repeat('1', 64)),
                          'forbidden', 'FAILED 8: a revoked key made a key');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_b, 'x', 'full', 'mdh_live_new1', repeat('1', 64)),
                          'forbidden', 'FAILED 8: another account''s key made a key');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_full, 'x', 'full', 'mdh_live_new1', repeat('1', 64), d1),
                          'validation', 'FAILED 8: a full key limited to a domain');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_full, 'x', 'sending', 'mdh_live_new1', repeat('1', 64), db),
                          'validation', 'FAILED 8: another account''s domain');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_full, ' ', 'full', 'mdh_live_new1', repeat('1', 64)),
                          'validation', 'FAILED 8: a blank name');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_full, 'x', 'admin', 'mdh_live_new1', repeat('1', 64)),
                          'validation', 'FAILED 8: an unknown permission');
  perform pg_temp.mv_code(mail.api_create_key(a_acc, k_full, 'x', 'full', 'sk_live_new1', repeat('1', 64)),
                          'validation', 'FAILED 8: a prefix that is not ours');
  execute 'reset role';
  update mail.accounts set state = 'closed' where id = a_acc;
  execute 'set local role service_role';
  v_j := mail.api_create_key(a_acc, k_full, 'x', 'full', 'mdh_live_new1', repeat('1', 64));
  execute 'reset role';
  perform pg_temp.mv_code(v_j, 'account_closed', 'FAILED 8: a closed account');
  update mail.accounts set state = 'active' where id = a_acc;

  execute 'set local role service_role';
  perform pg_temp.mv_code(mail.api_revoke_key(a_acc, k_send, v_id2), 'forbidden', 'FAILED 8: a sending key revoked a key');
  perform pg_temp.mv_code(mail.api_revoke_key(a_acc, k_full, k_b), 'not_found', 'FAILED 8: another account''s key');
  v_j := mail.api_revoke_key(a_acc, k_full, v_id2);
  v_j2 := mail.api_revoke_key(a_acc, k_full, v_id2);
  execute 'reset role';
  perform pg_temp.mv_ok(v_j, 'FAILED 8: a revoke');
  if (v_j2 ->> 'already')::boolean is not true
     or (select revoked_at from mail.api_keys where id = v_id2) is null
     or (select count(*) from mail.account_audit_log
          where account_id = a_acc and action = 'key.revoked' and actor = 'api' and target = v_id2::text) <> 1 then
    raise exception 'FAILED 8: the revoke answered % then %', v_j, v_j2;
  end if;
  execute 'set local role service_role';
  v_j := mail.authenticate_key(encode(extensions.digest(v_tag || 'new', 'sha256'), 'hex'));
  execute 'reset role';
  perform pg_temp.mv_code(v_j, 'unauthorized', 'FAILED 8: a revoked key still opens the door');
  v_passed := v_passed + 1;

  -- ── 9. Grants: each new function to exactly one role (or none); the batch
  -- table closed to every API role; signed-in people cannot reach the API's.
  v_expected := '{
    "recipient_addresses":"none", "as_timestamptz":"none", "utc_text":"none", "email_view":"none",
    "email_page":"none", "is_full_key":"none",
    "enqueue_email":"service_role", "enqueue_batch":"service_role", "get_email":"service_role",
    "list_emails":"service_role", "reschedule_email":"service_role", "cancel_email":"service_role",
    "api_list_keys":"service_role", "api_create_key":"service_role", "api_revoke_key":"service_role",
    "account_emails":"authenticated"
  }';
  v_n := 0;
  for v_row in select p.oid, p.proname from pg_proc p
                where p.pronamespace = 'mail'::regnamespace and v_expected ? p.proname loop
    v_want := v_expected ->> v_row.proname;
    if has_function_privilege('anon', v_row.oid, 'execute')
       or has_function_privilege('authenticated', v_row.oid, 'execute') is distinct from (v_want = 'authenticated')
       or has_function_privilege('service_role', v_row.oid, 'execute') is distinct from (v_want = 'service_role') then
      raise exception 'FAILED 9: mail.% has the wrong grants', v_row.proname;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(*) from jsonb_object_keys(v_expected)) then
    raise exception 'FAILED 9: % of % expected functions found', v_n, (select count(*) from jsonb_object_keys(v_expected));
  end if;
  if has_table_privilege('anon', 'mail.email_batches', 'select, insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'mail.email_batches', 'select, insert, update, delete, truncate')
     or has_table_privilege('service_role', 'mail.email_batches', 'select, insert, update, delete, truncate')
     or not (select relrowsecurity from pg_class where oid = 'mail.email_batches'::regclass) then
    raise exception 'FAILED 9: mail.email_batches is open to an API role';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'mail'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')) then
    raise exception 'FAILED 9: a security definer function in mail has no empty search_path';
  end if;
  perform pg_temp.mv_as(u_o);
  begin
    perform mail.list_emails(a_acc);
    raise exception 'FAILED 9: a signed-in person called list_emails';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.cancel_email(a_acc, v_id);
    raise exception 'FAILED 9: a signed-in person called cancel_email';
  exception when insufficient_privilege then null;
  end;
  begin
    perform mail.api_create_key(a_acc, k_full, 'x', 'full', 'mdh_live_new1', repeat('1', 64));
    raise exception 'FAILED 9: a signed-in person called api_create_key';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  execute 'set local role service_role';
  begin
    perform mail.account_emails(a_acc);
    raise exception 'FAILED 9: the secret key called account_emails';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  v_passed := v_passed + 1;

  raise notice 'migration 48: % checks passed', v_passed;
end;
$$;

rollback;
