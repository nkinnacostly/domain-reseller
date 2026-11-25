-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 74: the admin ops copilot (docs: "Making AI the core of
-- MyDomainsHub", feature 5).
--
-- On an alert, an admin may ask for a plain explanation and next steps, or a
-- draft ticket to DomainNameAPI's support. The copilot only reads and drafts:
-- it changes nothing, and every request is audited here first. The wrapper
-- answers with the alert's own words (kind, severity, summary) for the side
-- it is on, so what is explained is exactly what was audited; the web masks
-- domain names and contact details before anything leaves for the model.
-- ─────────────────────────────────────────────────────────────────────────────

-- As migration 73's, plus the copilot.
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
      ('order.review_screening',      'operator', false, 'test_target'),
      -- Migration 74: an alert explained by the ops copilot (reads; changes nothing).
      ('alert.explain',               'viewer',   false, 'test_target')
    ) as t (action, min_role, money, test_rule)
   where t.action = p_action
$$;

create function public.admin_alert_help(p_alert_id bigint, p_mode text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'alert.explain';
  v_admin  public.admins := public.admin_session('viewer', null, false);
  v_row    public.ops_alerts;
  v_side   text;
  v_code   text;
  v_detail jsonb;
  v_answer jsonb;
  v_prior  jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_alert_id::text);
  select * into v_row from public.ops_alerts where id = p_alert_id;
  if not found then
    if v_prior is not null then return v_prior; end if;
    return public.admin_record(v_admin, c_action, 'live', 'alert', p_alert_id::text, null, null,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  v_side := case when v_row.test_mode then 'test' else 'live' end;
  v_detail := jsonb_build_object('kind', v_row.kind, 'mode', p_mode);
  v_code := public.admin_gate(v_admin, c_action, v_row.test_mode);
  if v_code is null and coalesce(p_mode, '') not in ('explain', 'ticket') then v_code := 'BAD_MODE'; end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, v_side, 'alert', p_alert_id::text, v_row.test_mode,
                               null, p_request_key, 'refused', v_code, null, v_detail);
  end if;
  -- A repeated request (a lost answer) is the same audited read, answered again.
  v_answer := coalesce(v_prior, public.admin_record(v_admin, c_action, v_side, 'alert', p_alert_id::text,
                                                    v_row.test_mode, null, p_request_key, 'ok', null, null,
                                                    v_detail));
  return v_answer || jsonb_build_object('alert', jsonb_build_object(
    'kind', v_row.kind, 'severity', v_row.severity, 'summary', v_row.summary,
    'side', v_side, 'resolved', v_row.resolved_at is not null));
end $$;

revoke all on function public.admin_alert_help(bigint, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_alert_help(bigint, text, uuid) to authenticated;
