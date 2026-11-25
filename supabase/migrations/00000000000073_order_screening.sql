-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 73: order screening (docs: "Making AI the core of MyDomainsHub",
-- feature 6).
--
-- Every paid registration or transfer line is screened once, after payment,
-- by the gateway: a word list catches names built on a well-known brand or a
-- sign-in word (paypal-login, gtbank-verify); only those are put to a model
-- for a second opinion. A line the screening flags raises a warning for a
-- person to review — the order is never held or refused for it, and nothing
-- is decided without a person (GAID: no automated decision about a customer).
--
-- A review is an audited admin action (ADR-006), final once given.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.order_screenings (
  order_item_id uuid primary key references public.order_items (id) on delete cascade,
  test_mode     boolean not null,
  domain        text not null check (char_length(domain) between 3 and 253),
  verdict       text not null check (verdict in ('clear', 'review')),
  -- The listed words the name matched; empty for a clear name.
  matched       text[] not null default '{}',
  -- The model's one-line reason, or why it could not be asked.
  note          text check (note is null or char_length(note) <= 300),
  model         text check (model is null or char_length(model) <= 60),
  screened_at   timestamptz not null default now(),
  decision      text check (decision in ('fine', 'abuse')),
  review_note   text check (review_note is null or char_length(review_note) between 10 and 500),
  reviewed_by   text,
  reviewed_at   timestamptz,
  constraint order_screenings_review_whole
    check ((reviewed_at is null) = (decision is null)
           and (reviewed_at is null) = (review_note is null)
           and (reviewed_at is null) = (reviewed_by is null)
           and (reviewed_at is null or verdict = 'review'))
);
create index order_screenings_open on public.order_screenings (test_mode)
  where verdict = 'review' and reviewed_at is null;

alter table public.order_screenings enable row level security;
revoke all on public.order_screenings from public, anon, authenticated, service_role;
grant select, insert on public.order_screenings to service_role;

-- A screening is written once; only a review is added, by the wrapper, once.
-- A test-side one goes with its order when test orders are purged (the
-- cascade from order_items); a live one is never deleted.
create function public.order_screenings_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.test_mode then
      return old;
    end if;
    raise exception 'an order screening is never deleted';
  end if;
  if (new.order_item_id, new.test_mode, new.domain, new.verdict, new.matched, new.note, new.model, new.screened_at)
     is distinct from
     (old.order_item_id, old.test_mode, old.domain, old.verdict, old.matched, old.note, old.model, old.screened_at) then
    raise exception 'an order screening is never rewritten';
  end if;
  if old.reviewed_at is not null then
    raise exception 'a review is final';
  end if;
  if coalesce(current_setting('app.screening_reviewer', true), '') <> 'on' then
    raise exception 'a screening is reviewed only through admin_review_screening';
  end if;
  return new;
end;
$$;

create trigger order_screenings_final
  before update or delete on public.order_screenings
  for each row execute function public.order_screenings_final();

-- Paid registration and transfer lines from the last seven days with no
-- screening yet, oldest first, on one side.
create function public.order_lines_to_screen(p_test_mode boolean, p_limit integer default 50)
returns table (order_item_id uuid, domain text)
language sql
stable
security definer
set search_path = ''
as $$
  select oi.id, oi.domain::text
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.test_mode = p_test_mode
     and o.paid_at is not null and o.paid_at > now() - interval '7 days'
     and oi.item_type in ('register', 'transfer')
     and not exists (select 1 from public.order_screenings s where s.order_item_id = oi.id)
   order by o.paid_at, oi.id
   limit greatest(1, least(p_limit, 200))
$$;
revoke all on function public.order_lines_to_screen(boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.order_lines_to_screen(boolean, integer) to service_role;

-- As migration 41's, plus the screenings that wait for a person.
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
$function$;

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
      ('supplier.explain_charge',     'owner',    true,  'never'),
      -- Migration 73: a screened order line reviewed by a person.
      ('order.review_screening',      'operator', false, 'test_target')
    ) as t (action, min_role, money, test_rule)
   where t.action = p_action
$$;

-- ADMIN-SPEC §3.1.1: identity, replay, the line read and locked, the gate
-- (operator; a test admin on a test line only), the reason, then the review.
create function public.admin_review_screening(p_order_item_id uuid, p_decision text, p_reason text,
                                              p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'order.review_screening';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_row    public.order_screenings;
  v_side   text;
  v_prior  jsonb;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_order_item_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_row from public.order_screenings where order_item_id = p_order_item_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, 'live', 'order_item', p_order_item_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_row.test_mode then 'test' else 'live' end;
  v_detail := jsonb_build_object('domain', v_row.domain, 'matched', to_jsonb(v_row.matched),
                                 'decision', p_decision);
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_row.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and coalesce(p_decision, '') not in ('fine', 'abuse') then v_code := 'BAD_DECISION'; end if;
  if v_code is null and (v_row.verdict <> 'review' or v_row.reviewed_at is not null) then
    v_code := 'NOT_FOR_REVIEW';
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'order_item', p_order_item_id::text, v_row.test_mode,
                               p_reason, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  perform set_config('app.screening_reviewer', 'on', true);
  update public.order_screenings
     set decision = p_decision, review_note = trim(p_reason), reviewed_by = v_admin.label, reviewed_at = now()
   where order_item_id = p_order_item_id;
  perform set_config('app.screening_reviewer', '', true);
  return public.admin_record(v_admin, c_action, v_side, 'order_item', p_order_item_id::text, v_row.test_mode,
    p_reason, p_request_key, 'ok', null, null, v_detail || jsonb_build_object('after', jsonb_build_object('decision', p_decision)));
end $$;

revoke all on function public.admin_review_screening(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_review_screening(uuid, text, text, uuid) to authenticated;
