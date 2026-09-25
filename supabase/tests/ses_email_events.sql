-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 34: SES delivery events, tried as the database owner. Each check
-- fails the script if it does not hold. Everything is rolled back, and
-- nothing is sent: these rows are written straight into the outbox as the
-- gateway would leave them after sending.
--
--   supabase db query --linked -f supabase/tests/ses_email_events.sql
-- ─────────────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  v_user     uuid := extensions.gen_random_uuid();
  v_worker   text := 'ses-check-' || extensions.gen_random_uuid();
  v_tag      text := left(extensions.gen_random_uuid()::text, 8);
  v_notice   uuid;
  v_security uuid;
  v_receipt  uuid;
  v_late     uuid;
  v_quiet    uuid;
  v_recent   uuid;
  v_waiting  uuid;
  v_row      public.email_outbox;
  v_checked  timestamptz;
  v_alert    record;
  v_passed   integer := 0;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'ses-check-' || v_user || '@mydomainshub.com', now(), now());

  -- An ERRP notice as the gateway leaves it: claimed, then marked sent with SES's id —
  -- which also enters it in the compliance log (migration 31).
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, claimed_by, claimed_at, attempts)
  values ('expiry_notice', 'compliance', v_user, 'ses-check@mydomainshub.com',
          jsonb_build_object('domain', 'ses-check-' || v_tag || '.com', 'notice', 'errp_pre_7',
                             'expires_at', now() + interval '7 days'),
          'ses-check:notice:' || v_tag, true, 'sending', v_worker, now(), 1)
  returning id into v_notice;
  if not public.mark_email_sent(v_notice, v_worker, 'ses-' || v_tag || '-notice-000000', 'expiry_notice@1') then
    raise exception 'needs mark_email_sent to work';
  end if;
  -- A security notice and a receipt, sent.
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, provider_message_id, sent_at)
  values ('password_changed', 'security', v_user, 'ses-check@mydomainshub.com', '{}',
          'ses-check:security:' || v_tag, true, 'sent', 'ses-' || v_tag || '-security-000000', now())
  returning id into v_security;
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, provider_message_id, sent_at)
  values ('order_receipt', 'transactional', v_user, 'ses-check@mydomainshub.com',
          jsonb_build_object('order_number', 'ND-SES-' || v_tag),
          'ses-check:receipt:' || v_tag, true, 'sent', 'ses-' || v_tag || '-receipt-000000', now())
  returning id into v_receipt;

  -- 1. Unknown or empty message ids are a no-op; an unknown event name is refused.
  if public.record_email_event('ses-' || v_tag || '-nobody-000000', 'delivery')
     or public.record_email_event('', 'delivery')
     or public.record_email_event(null, 'bounce') then
    raise exception 'FAILED 1: recorded an event for a message that is not ours';
  end if;
  begin
    perform public.record_email_event('ses-' || v_tag || '-notice-000000', 'Delivery');
    raise exception 'FAILED 1: accepted an event name it does not know';
  exception when invalid_parameter_value then null;
  end;
  v_passed := v_passed + 1;

  -- 2. A delay is deferred; a delivery then makes it delivered, in the compliance log too.
  if not public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery_delay',
                                   '{"delay_type": "MailboxFull"}') then
    raise exception 'FAILED 2: a delay for our notice was not recorded';
  end if;
  select * into v_row from public.email_outbox where id = v_notice;
  if v_row.delivery_status <> 'deferred' or v_row.delivery_detail ->> 'delay_type' <> 'MailboxFull'
     or (select delivery_status from public.compliance_notices where email_id = v_notice) <> 'sent' then
    raise exception 'FAILED 2: delay %', to_jsonb(v_row);
  end if;
  perform public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery',
                                    '{"at": "2026-09-25T08:00:00Z"}');
  select * into v_row from public.email_outbox where id = v_notice;
  if v_row.delivery_status <> 'delivered' or v_row.delivery_checked_at is null
     or v_row.delivery_detail ->> 'event' <> 'delivery'
     or (select delivery_status from public.compliance_notices where email_id = v_notice) <> 'delivered' then
    raise exception 'FAILED 2: delivery %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 3. A repeated delivery, or a delay after it, changes nothing (never downgraded).
  v_checked := v_row.delivery_checked_at;
  if not public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery')
     or not public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery_delay') then
    raise exception 'FAILED 3: a repeat was not recognised as ours';
  end if;
  select * into v_row from public.email_outbox where id = v_notice;
  if v_row.delivery_status <> 'delivered' or v_row.delivery_checked_at <> v_checked then
    raise exception 'FAILED 3: a repeat or a delay changed a delivered notice: %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 4. A late bounce wins over the delivery: the compliance log says bounced and a
  --    critical alert asks for the registrant to be reached another way.
  perform public.record_email_event('ses-' || v_tag || '-notice-000000', 'bounce',
                                    '{"bounce_type": "Permanent", "bounce_sub_type": "General"}');
  select * into v_row from public.email_outbox where id = v_notice;
  if v_row.delivery_status <> 'bounced' or v_row.delivery_detail ->> 'bounce_type' <> 'Permanent'
     or (select delivery_status from public.compliance_notices where email_id = v_notice) <> 'bounced'
     or not exists (select 1 from public.current_alert_conditions(true) a
                     where a.kind = 'compliance_notice_bounced' and a.severity = 'critical'
                       and a.summary like '%ses-check-' || v_tag || '.com%') then
    raise exception 'FAILED 4: a late bounce did not win: %', to_jsonb(v_row);
  end if;
  v_passed := v_passed + 1;

  -- 5. A bounced email stays bounced, whatever arrives after.
  perform public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery');
  perform public.record_email_event('ses-' || v_tag || '-notice-000000', 'delivery_delay');
  if (select delivery_status from public.email_outbox where id = v_notice) <> 'bounced'
     or (select delivery_status from public.compliance_notices where email_id = v_notice) <> 'bounced' then
    raise exception 'FAILED 5: a bounce was undone';
  end if;
  v_passed := v_passed + 1;

  -- 6. A transient bounce, a rejection and a rendering failure all mean it did not arrive.
  perform public.record_email_event('ses-' || v_tag || '-security-000000', 'bounce', '{"bounce_type": "Transient"}');
  if (select delivery_status from public.email_outbox where id = v_security) <> 'bounced' then
    raise exception 'FAILED 6: a transient bounce';
  end if;
  update public.email_outbox set delivery_status = null where id in (v_security, v_receipt);
  perform public.record_email_event('ses-' || v_tag || '-security-000000', 'reject', '{"reason": "Bad content"}');
  perform public.record_email_event('ses-' || v_tag || '-receipt-000000', 'rendering_failure');
  if (select delivery_status from public.email_outbox where id = v_security) <> 'bounced'
     or (select delivery_status from public.email_outbox where id = v_receipt) <> 'bounced' then
    raise exception 'FAILED 6: a rejection or a rendering failure';
  end if;
  v_passed := v_passed + 1;

  -- 7. A complaint is recorded and raised, but is not a bounce — the email arrived.
  update public.email_outbox set delivery_status = 'delivered' where id = v_receipt;
  if not public.record_email_event('ses-' || v_tag || '-receipt-000000', 'complaint',
                                   '{"complaint_type": "abuse"}') then
    raise exception 'FAILED 7: a complaint about our email was not recorded';
  end if;
  select * into v_row from public.email_outbox where id = v_receipt;
  v_checked := v_row.complained_at;
  if v_row.complained_at is null or v_row.delivery_status <> 'delivered'
     or v_row.delivery_detail -> 'complaint' ->> 'complaint_type' <> 'abuse'
     or not exists (select 1 from public.current_alert_conditions(true) a
                     where a.key = 'email_complaint:' || v_receipt and a.severity = 'warning'
                       and a.summary like '%ND-SES-' || v_tag || '%') then
    raise exception 'FAILED 7: complaint %', to_jsonb(v_row);
  end if;
  -- A repeat keeps the first; a later bounce still wins, and keeps the complaint.
  perform public.record_email_event('ses-' || v_tag || '-receipt-000000', 'complaint');
  perform public.record_email_event('ses-' || v_tag || '-receipt-000000', 'bounce', '{"bounce_type": "Permanent"}');
  select * into v_row from public.email_outbox where id = v_receipt;
  if v_row.complained_at <> v_checked or v_row.delivery_status <> 'bounced'
     or v_row.delivery_detail -> 'complaint' ->> 'complaint_type' <> 'abuse' then
    raise exception 'FAILED 7: a repeated complaint or a later bounce: %', to_jsonb(v_row);
  end if;
  -- Nothing on the live side, and nothing for an email nobody complained about.
  if exists (select 1 from public.current_alert_conditions(false) a where a.key = 'email_complaint:' || v_receipt)
     or exists (select 1 from public.current_alert_conditions(true) a where a.key = 'email_complaint:' || v_security) then
    raise exception 'FAILED 7: complaint alert on the wrong email or side';
  end if;
  v_passed := v_passed + 1;

  -- 8. No report a day after sending: an alert — critical for an ERRP notice — and
  --    never a delivery. Not before a day, not once reported, not for a receipt.
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, provider_message_id, sent_at, delivery_status)
  values ('expiry_notice', 'compliance', v_user, 'ses-check@mydomainshub.com',
          jsonb_build_object('domain', 'ses-quiet-' || v_tag || '.com', 'notice', 'errp_post'),
          'ses-check:quiet:' || v_tag, true, 'sent', 'ses-' || v_tag || '-quiet-000000',
          now() - interval '26 hours', null)
  returning id into v_quiet;
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, provider_message_id, sent_at, delivery_status)
  values ('new_sign_in', 'security', v_user, 'ses-check@mydomainshub.com', '{}',
          'ses-check:late:' || v_tag, true, 'sent', 'ses-' || v_tag || '-late-000000',
          now() - interval '30 hours', 'deferred')
  returning id into v_late;
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, provider_message_id, sent_at)
  values ('new_sign_in', 'security', v_user, 'ses-check@mydomainshub.com', '{}',
          'ses-check:recent:' || v_tag, true, 'sent', 'ses-' || v_tag || '-recent-000000',
          now() - interval '2 hours')
  returning id into v_recent;
  update public.email_outbox set sent_at = now() - interval '30 hours', delivery_status = null
   where id = v_receipt;
  select * into v_alert from public.current_alert_conditions(true) a where a.key = 'email_unconfirmed:' || v_quiet;
  if v_alert.key is null or v_alert.severity <> 'critical' or v_alert.summary not like '%ses-quiet-' || v_tag || '.com%'
     or v_alert.summary not like '%not counted as delivered%' then
    raise exception 'FAILED 8: an unreported ERRP notice raised no critical alert (%)', to_jsonb(v_alert);
  end if;
  if not exists (select 1 from public.current_alert_conditions(true) a
                  where a.key = 'email_unconfirmed:' || v_late and a.severity = 'warning')
     or exists (select 1 from public.current_alert_conditions(true) a
                 where a.key in ('email_unconfirmed:' || v_recent, 'email_unconfirmed:' || v_receipt,
                                 'email_unconfirmed:' || v_notice))
     or exists (select 1 from public.current_alert_conditions(false) a where a.key = 'email_unconfirmed:' || v_quiet) then
    raise exception 'FAILED 8: unconfirmed-delivery alerts on the wrong emails';
  end if;
  if (select delivery_status from public.email_outbox where id = v_quiet) is not null then
    raise exception 'FAILED 8: an unreported email was given a delivery status';
  end if;
  -- A report clears it; after four days it is left to the log.
  perform public.record_email_event('ses-' || v_tag || '-quiet-000000', 'delivery');
  update public.email_outbox set sent_at = now() - interval '5 days' where id = v_late;
  if exists (select 1 from public.current_alert_conditions(true) a
              where a.key in ('email_unconfirmed:' || v_quiet, 'email_unconfirmed:' || v_late)) then
    raise exception 'FAILED 8: the alert outlived its report or its window';
  end if;
  v_passed := v_passed + 1;

  -- 9. The waiting-email alert names no one provider's key.
  insert into public.email_outbox (kind, category, user_id, to_email, data, dedupe_key, test_mode,
                                   status, created_at)
  values ('password_changed', 'security', v_user, 'ses-check@mydomainshub.com', '{}',
          'ses-check:waiting:' || v_tag, true, 'pending', now() - interval '2 hours')
  returning id into v_waiting;
  select * into v_alert from public.current_alert_conditions(true) a where a.kind = 'emails_waiting';
  if v_alert.key is null or v_alert.summary like '%BREVO%' or v_alert.summary not like '%EMAIL_PROVIDER%' then
    raise exception 'FAILED 9: waiting alert %', to_jsonb(v_alert);
  end if;
  v_passed := v_passed + 1;

  -- 10. The alerts of earlier migrations are all still there.
  update public.email_outbox set status = 'failed', last_error = 'HTTP 400 MessageRejected', updated_at = now()
   where id = v_waiting;
  if not exists (select 1 from public.current_alert_conditions(true) a where a.key = 'email_failed:' || v_waiting) then
    raise exception 'FAILED 10: the failed-email alert went missing';
  end if;
  perform count(*) from public.current_alert_conditions(false);
  v_passed := v_passed + 1;

  -- 11. Only the server key may record events.
  if has_function_privilege('anon', 'public.record_email_event(text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.record_email_event(text, text, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.record_email_event(text, text, jsonb)', 'execute')
     or has_table_privilege('service_role', 'public.email_outbox', 'update') then
    raise exception 'FAILED 11: grants';
  end if;
  v_passed := v_passed + 1;

  raise notice 'SES email events: % checks passed', v_passed;
end;
$$;

rollback;
