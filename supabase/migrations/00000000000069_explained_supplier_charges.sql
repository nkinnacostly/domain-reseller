-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 69: a supplier charge explained by hand (docs/ADMIN-SPEC.md §7.3).
--
-- A debit with no provisioning call is a critical alert
-- (`supplier_unexplained_charge`), and alerts close only when their condition
-- goes away. A domain the owner bought in DomainNameAPI's own panel
-- (vissioncapitals.org, 31 Oct 2026) can never match a call, so its alert
-- repeated every two hours for 90 days. Now an owner says what the charge was:
-- the entry becomes `explained`, with the words, who and when beside it, and
-- the alert closes because its condition — `match_state = 'unexplained'` — is
-- gone. The supplier's facts are untouched, the matcher never revisits an
-- explained entry (it reads pending, unexplained and unclassified only), and
-- an explanation, once given, is never rewritten.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.supplier_ledger_entries
  drop constraint supplier_ledger_entries_match_state_check,
  add constraint supplier_ledger_entries_match_state_check
    check (match_state in ('pending', 'matched', 'topup', 'unexplained', 'unclassified', 'explained')),
  add column explained_note text check (explained_note is null or char_length(explained_note) between 10 and 500),
  add column explained_by   text check (explained_by is null or char_length(explained_by) between 1 and 80),
  add column explained_at   timestamptz,
  -- All three or none, and only on an explained entry.
  add constraint supplier_ledger_entries_explained_whole
    check ((match_state = 'explained') = (explained_at is not null)
           and (explained_at is null) = (explained_note is null)
           and (explained_at is null) = (explained_by is null));

-- As migration 41's, plus: only admin_explain_supplier_charge gives an
-- explanation (`app.ledger_explainer`), and one given is final.
create or replace function public.supplier_ledger_is_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if tg_op = 'DELETE' then
    if old.test_mode and old.description like 'e2e-%' then
      return old;
    end if;
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if (new.test_mode, new.trace_id, new.occurred_at, new.type, new.charge_type, new.product_type,
      new.product_id, new.description, new.period, new.old_balance_cents, new.balance_cents, new.recorded_at)
     is distinct from
     (old.test_mode, old.trace_id, old.occurred_at, old.type, old.charge_type, old.product_type,
      old.product_id, old.description, old.period, old.old_balance_cents, old.balance_cents, old.recorded_at) then
    raise exception 'the supplier ledger is never rewritten';
  end if;
  if new.status is distinct from old.status
     and coalesce(current_setting('app.ledger_writer', true), '') <> 'on' then
    raise exception 'a ledger status changes only through record_supplier_ledger';
  end if;
  if old.explained_at is not null
     and (new.match_state, new.explained_note, new.explained_by, new.explained_at)
         is distinct from (old.match_state, old.explained_note, old.explained_by, old.explained_at) then
    raise exception 'an explained supplier charge is never rewritten';
  end if;
  if new.explained_at is distinct from old.explained_at
     and coalesce(current_setting('app.ledger_explainer', true), '') <> 'on' then
    raise exception 'a supplier charge is explained only through admin_explain_supplier_charge';
  end if;
  return new;
end;
$$;

create or replace function public.admin_tier(p_action text, out min_role text, out money boolean, out test_rule text)
language sql
immutable
set search_path = ''
as $$
  select t.min_role, t.money, t.test_rule
    from (values
      ('refund.approve',              'operator', true,  'test_target'),
      ('refund.retry',                'operator', true,  'test_target'),
      ('refund.record_manual',        'operator', true,  'test_target'),
      ('refund.cancel',               'owner',    true,  'never'),
      ('refund.flw_check',            'operator', false, 'test_target'),
      ('incident.resolve',            'operator', false, 'test_target'),
      ('incident.resolve_money',      'operator', true,  'test_target'),
      ('job.retry',                   'operator', true,  'test_target'),
      ('job.fail',                    'operator', true,  'test_target'),
      ('ssl_job.retry',               'operator', true,  'test_target'),
      ('ssl_job.fail',                'operator', true,  'test_target'),
      ('email.requeue',               'operator', false, 'reserved_target'),
      ('domain.deep_sync',            'operator', false, 'test_target'),
      ('domain.reveal_contacts',      'operator', false, 'reserved_target'),
      ('customer.search',             'operator', false, 'reserved_target'),
      ('customer.reveal',             'operator', false, 'reserved_target'),
      ('fx.activate',                 'owner',    true,  'never'),
      ('fx.reject',                   'owner',    true,  'never'),
      ('pricing.update',              'owner',    true,  'never'),
      ('settings.update',             'owner',    true,  'never'),
      ('settings.refund_limit_raise', 'owner',    true,  'never'),
      ('extension.flags',             'owner',    true,  'never'),
      ('ssl_product.sellable',        'owner',    true,  'never'),
      ('preset.draft_save',           'owner',    true,  'never'),
      ('preset.publish',              'owner',    true,  'never'),
      ('preset.show',                 'owner',    true,  'never'),
      ('preset.draft_check',          'owner',    false, 'never'),
      ('preset.draft_discard',        'owner',    false, 'never'),
      ('preset.hide',                 'operator', false, 'never'),
      ('topup.record',                'owner',    true,  'never'),
      ('topup.correct',               'owner',    true,  'never'),
      ('audit.redact',                'owner',    true,  'never'),
      ('supplier.balance',            'viewer',   false, 'test_target'),
      ('supplier.ledger_live',        'viewer',   false, 'test_target'),
      ('supplier.domain_lookup',      'operator', false, 'test_target'),
      ('supplier.domains_page',       'operator', false, 'test_target'),
      ('supplier.verification',       'operator', false, 'test_target'),
      ('supplier.ssl_lookup',         'operator', false, 'test_target'),
      ('supplier.transfer_query',     'operator', false, 'test_target'),
      ('supplier.renew_check',        'operator', false, 'test_target'),
      ('supplier.price_check',        'operator', false, 'never'),
      ('supplier.catalogue_preview',  'owner',    false, 'never'),
      ('supplier.ssl_catalogue_preview', 'owner', false, 'never'),
      ('supplier.catalogue_apply',    'owner',    true,  'never'),
      ('supplier.ssl_catalogue_apply', 'owner',   true,  'never'),
      -- Migration 51: MyDomainsHub Mail (MAIL-SPEC §7.2, §7.4, §10, MR5).
      ('mail.approve',                'operator', false, 'test_target'),
      ('mail.reject',                 'operator', false, 'test_target'),
      ('mail.pause',                  'operator', false, 'test_target'),
      ('mail.resume',                 'owner',    true,  'never'),
      ('mail.cap_override',           'owner',    true,  'never'),
      -- Migration 69: a supplier charge explained by hand.
      ('supplier.explain_charge',     'owner',    true,  'never')
    ) as t (action, min_role, money, test_rule)
   where t.action = p_action
$$;

-- ADMIN-SPEC §3.1.1, as admin_record_float_topup: identity, replay, the entry
-- read and locked, the gate (owner, a fresh code; never a test admin), the
-- reason — which is the explanation, 10 to 500 characters — then the change.
create function public.admin_explain_supplier_charge(p_test_mode boolean, p_trace_id uuid, p_reason text,
                                                     p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'supplier.explain_charge';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_test   boolean := coalesce(p_test_mode, false);
  v_side   text := case when coalesce(p_test_mode, false) then 'test' else 'live' end;
  v_prior  jsonb;
  v_entry  public.supplier_ledger_entries;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_trace_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_entry from public.supplier_ledger_entries
   where test_mode = v_test and trace_id = p_trace_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_detail := jsonb_build_object('usd_cents', -v_entry.delta_cents, 'description', left(v_entry.description, 80),
                                 'before', jsonb_build_object('match_state', v_entry.match_state));
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_test), public.admin_reason_problem(p_reason));
  if v_code is null and v_entry.match_state <> 'unexplained' then v_code := 'NOT_UNEXPLAINED'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  perform set_config('app.ledger_explainer', 'on', true);
  update public.supplier_ledger_entries
     set match_state = 'explained', explained_note = trim(p_reason), explained_by = v_admin.label,
         explained_at = now()
   where test_mode = v_entry.test_mode and trace_id = v_entry.trace_id;
  perform set_config('app.ledger_explainer', '', true);
  return public.admin_record(v_admin, c_action, v_side, 'ledger', p_trace_id::text, v_test,
    p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', jsonb_build_object('match_state', 'explained')));
end $$;

revoke all on function public.admin_explain_supplier_charge(boolean, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_explain_supplier_charge(boolean, uuid, text, uuid) to authenticated;
