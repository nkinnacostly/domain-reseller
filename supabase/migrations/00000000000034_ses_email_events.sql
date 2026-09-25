-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 34: Amazon SES delivery events (L1, FR-NT3).
--
-- With EMAIL_PROVIDER=ses the gateway sends the outbox — and the web the
-- auth emails — through Amazon SES instead of Brevo. SES cannot be asked
-- what became of a message: the `mydomainshub` configuration set publishes
-- each delivery, bounce, complaint, rejection, delay and rendering failure
-- to SNS, and the web's /api/email/ses-events verifies the SNS signature and
-- records it here, by the provider message id the gateway stored on sending
-- (`email_outbox.provider_message_id`, the column Brevo's ids use).
--
-- Events map onto the delivery_status values Brevo's read-back uses:
--   delivery                        → delivered
--   delivery_delay                  → deferred (SES is still trying)
--   bounce (any type), reject,
--   rendering_failure               → bounced (SES reports a soft bounce
--                                     only once it has stopped retrying:
--                                     either way, this message did not arrive)
-- A final state (delivered, bounced) is never downgraded to deferred, and a
-- bounce after a delivery wins — late bounces happen. A complaint is kept
-- (`complained_at`) and raises an alert, but is not a bounce: the email
-- arrived. Every rule makes a repeated event a no-op, so SNS may deliver one
-- twice. Compliance notices follow exactly as with record_email_delivery.
--
-- Nothing polls SES, so a missing report must not pass silently: an ERRP or
-- security email sent over a day ago with no final report raises an alert
-- (critical for ERRP notices) for three days. It is never assumed delivered.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.email_outbox
  -- When the recipient reported it as spam (SES suppresses the address after).
  add column complained_at    timestamptz,
  -- The provider event behind delivery_status: its name and type codes only,
  -- never an address or diagnostic text. Purged with the row after 90 days.
  add column delivery_detail  jsonb;

-- Events find their email by the provider's message id.
create index email_outbox_provider_message_idx
  on public.email_outbox (provider_message_id)
  where provider_message_id is not null;

-- One provider event for one message. False when the message is not one of
-- ours (an auth email, a row already purged) — nothing to record.
create or replace function public.record_email_event(
  p_message_id text,
  p_event      text,
  p_detail     jsonb default '{}'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  public.email_outbox;
  v_seen   text;
  v_next   text;
  v_detail jsonb;
begin
  if p_event is null or p_event not in ('delivery', 'bounce', 'complaint', 'reject',
                                        'delivery_delay', 'rendering_failure') then
    raise exception 'not an email event: %', p_event using errcode = '22023';
  end if;
  if coalesce(btrim(p_message_id), '') = '' then
    return false;
  end if;
  v_detail := jsonb_build_object('event', p_event)
              || case when jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end;

  select * into v_email
    from public.email_outbox
   where provider_message_id = p_message_id and status = 'sent'
   order by sent_at desc
   limit 1
   for update;
  if v_email.id is null then
    return false;
  end if;

  if p_event = 'complaint' then
    -- The first complaint is the one kept; a repeat changes nothing.
    if v_email.complained_at is null then
      update public.email_outbox
         set complained_at = now(),
             delivery_detail = coalesce(delivery_detail, '{}'::jsonb)
                               || jsonb_build_object('complaint', v_detail)
       where id = v_email.id;
    end if;
    return true;
  end if;

  v_seen := case p_event
              when 'delivery' then 'delivered'
              when 'delivery_delay' then 'deferred'
              else 'bounced'
            end;
  -- bounced > delivered > deferred > nothing: never downgraded, a late bounce wins.
  v_next := case
              when 'bounced' in (v_email.delivery_status, v_seen) then 'bounced'
              when 'delivered' in (v_email.delivery_status, v_seen) then 'delivered'
              else 'deferred'
            end;
  if v_next is not distinct from v_email.delivery_status then
    return true;
  end if;

  update public.email_outbox
     set delivery_status = v_next,
         delivery_checked_at = now(),
         delivery_detail = case when complained_at is null then v_detail
                                else v_detail || jsonb_build_object('complaint', delivery_detail -> 'complaint')
                           end
   where id = v_email.id;
  if v_next in ('delivered', 'bounced') then
    update public.compliance_notices
       set delivery_status = v_next, delivery_checked_at = now()
     where email_id = v_email.id;
  end if;
  return true;
end;
$$;

revoke all on function public.record_email_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_email_event(text, text, jsonb) to service_role;

-- ── Alerts ──────────────────────────────────────────────────────────────────
-- The conditions of migration 32, the waiting-email alert worded for either
-- provider, and two more about delivery reports.
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
  -- has no credentials for its provider (EMAIL_PROVIDER), or the provider is refusing.
  select 'emails_waiting:' || p_test_mode::text,
         'warning',
         'emails_waiting',
         format('%s emails have waited over 30 minutes to be sent — check the gateway''s email sender and its provider''s credentials (EMAIL_PROVIDER)',
                count(*))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status in ('pending', 'sending')
     and e.created_at < now() - interval '30 minutes'
  having count(*) > 0

  union all
  -- FR-D2: a preset the DNS check hid — customers no longer see it.
  select 'preset_hidden:' || p.id,
         'critical',
         'preset_hidden',
         format('Host preset %s is hidden: its nameservers stopped resolving on %s. Check the provider''s documentation, fix or retire it.',
                p.provider, to_char(p.check_failed_since, 'DD Mon'))
    from public.nameserver_presets p
   where p_test_mode = false and p.is_hidden and p.auto_hidden_at is not null

  union all
  -- …and one failing, not yet hidden.
  select 'preset_failing:' || p.id,
         'warning',
         'preset_failing',
         format('Host preset %s: its nameservers are not resolving (since %s). It is hidden after a day.',
                p.provider, to_char(p.check_failed_since, 'DD Mon HH24:MI'))
    from public.nameserver_presets p
   where p_test_mode = false and p.check_failed_since is not null and not p.is_hidden

  union all
  -- The quarterly re-verification against the provider's own documentation.
  select 'preset_stale:' || p.id,
         'warning',
         'preset_stale',
         format('Host preset %s was last verified against its documentation on %s — check it again and update verified_at.',
                p.provider, to_char(p.verified_at, 'DD Mon YYYY'))
    from public.nameserver_presets p
   where p_test_mode = false and not p.is_hidden and p.verified_at < now() - interval '90 days'

  union all
  -- FR-NT3: an ERRP or security email with no final delivery report a day
  -- after sending. SES pushes its reports (migration 34) and Brevo is read
  -- back; either way a missing one is not a delivery. Raised for three days.
  select 'email_unconfirmed:' || e.id,
         case when e.category = 'compliance' then 'critical' else 'warning' end,
         'email_unconfirmed',
         format('A %s email (%s%s) sent %s UTC has no delivery report — check the email provider''s log; it is not counted as delivered',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')),
                to_char(e.sent_at at time zone 'UTC', 'DD Mon HH24:MI'))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.status = 'sent'
     and e.category in ('compliance', 'security')
     and coalesce(e.delivery_status, 'deferred') = 'deferred'
     and e.sent_at < now() - interval '24 hours'
     and e.sent_at > now() - interval '4 days'

  union all
  -- A recipient reported one of our emails as spam (SES, migration 34).
  -- Complaints cost the sending domain its reputation, and SES now
  -- suppresses the address. Raised for three days.
  select 'email_complaint:' || e.id,
         'warning',
         'email_complaint',
         format('A %s email (%s%s) was reported as spam by its recipient — SES will not send to that address again until it leaves the account''s suppression list',
                e.category, replace(e.kind, '_', ' '),
                coalesce(', ' || (e.data ->> 'domain'), coalesce(', order ' || (e.data ->> 'order_number'), '')))
    from public.email_outbox e
   where e.test_mode = p_test_mode
     and e.complained_at > now() - interval '3 days'
$function$;
