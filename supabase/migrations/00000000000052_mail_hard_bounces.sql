-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 52: MyDomainsHub Mail — `usage_daily.bounced` counts hard bounces
-- only (docs/MAIL-SPEC.md §7.4, §9).
--
-- MB6's threshold pause (migration 51) compares an account's `bounced` with
-- AWS's bounce rate, which counts hard (Permanent) bounces. Migration 49's
-- record_send_event counted every bounce; this one counts a bounce only when
-- SES's bounceType is Permanent. A soft (Transient or Undetermined) bounce is
-- still an event, still moves the email's status as before, still queues the
-- customer's email.bounced webhook, and still never suppresses. Nothing else
-- changes; the grant is restated (service_role only).
--
-- supabase/tests/mail_events.sql and mail_sending.sql (check 11) check it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mail.record_send_event(p_event text, p_message_id text default null,
                                                  p_email_public_id uuid default null, p_event_key text default null,
                                                  p_occurred_at timestamptz default null, p_detail jsonb default '{}',
                                                  p_recipients integer default 1, p_suppress text[] default '{}')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  mail.emails;
  v_seen   text;
  v_rank   integer;
  v_at     timestamptz := least(coalesce(p_occurred_at, now()), now() + interval '5 minutes');
  v_n      integer := least(greatest(coalesce(p_recipients, 1), 1), 50);
  v_new    bigint;
  v_reason text;
  v_detail jsonb := mail.sanitise_detail(p_detail);
  v_hook   text;
  v_extra  jsonb := '{}';
begin
  if p_event is null or p_event not in ('send', 'delivery', 'bounce', 'complaint', 'reject',
                                        'delivery_delay', 'rendering_failure') then
    raise exception 'not a send event: %', p_event using errcode = '22023';
  end if;

  if coalesce(btrim(p_message_id), '') <> '' then
    select * into v_email from mail.emails where ses_message_id = p_message_id for update;
  end if;
  if v_email.id is null and p_email_public_id is not null then
    select * into v_email from mail.emails
     where public_id = p_email_public_id
       and (ses_message_id is null or ses_message_id = p_message_id)
       and status not in ('queued', 'suppressed', 'canceled')
     for update;
    if v_email.id is not null and v_email.ses_message_id is null and coalesce(btrim(p_message_id), '') <> '' then
      update mail.emails set ses_message_id = p_message_id where id = v_email.id;
    end if;
  end if;
  if v_email.id is null then
    return false;
  end if;

  insert into mail.email_events (email_id, account_id, type, event_key, occurred_at, detail)
  values (v_email.id, v_email.account_id, p_event, nullif(left(p_event_key, 200), ''), v_at, v_detail)
  on conflict (email_id, event_key) where event_key is not null do nothing
  returning id into v_new;
  if v_new is null then
    return true;   -- seen before
  end if;

  v_seen := case p_event
              when 'send' then 'sent'
              when 'delivery' then 'delivered'
              when 'complaint' then 'complained'
              when 'bounce' then 'bounced'
              when 'reject' then 'failed'
              when 'rendering_failure' then 'failed'
              else null
            end;
  v_rank := case v_seen when 'sent' then 1 when 'delivered' then 2 when 'complained' then 3
                        when 'bounced' then 4 when 'failed' then 4 else 0 end;

  update mail.emails e
     set status = case
                    when v_seen is not null
                         and v_rank > case e.status when 'sent' then 1 when 'delivered' then 2 when 'complained' then 3
                                                    when 'bounced' then 4 when 'failed' then 4 else 0 end
                    then v_seen else e.status end,
         status_reason = case when v_seen = 'failed' and e.status not in ('bounced', 'failed') then p_event
                              else e.status_reason end,
         delivered_at = case when p_event = 'delivery' then coalesce(e.delivered_at, v_at) else e.delivered_at end,
         bounced_at = case when p_event = 'bounce' then coalesce(e.bounced_at, v_at) else e.bounced_at end,
         complained_at = case when p_event = 'complaint' then coalesce(e.complained_at, v_at) else e.complained_at end,
         failed_at = case when v_seen = 'failed' then coalesce(e.failed_at, v_at) else e.failed_at end,
         last_event = case when e.last_event_at is null or v_at >= e.last_event_at then p_event else e.last_event end,
         last_event_at = greatest(coalesce(e.last_event_at, v_at), v_at),
         updated_at = now()
   where e.id = v_email.id;

  case p_event
    when 'delivery' then perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'delivered', v_n);
    when 'bounce' then
      -- Hard bounces only: MB6's threshold pause (migration 51) compares this
      -- count with AWS's hard-bounce rate. A soft one is in the events and the
      -- status, as before.
      if coalesce(p_detail ->> 'bounceType', '') = 'Permanent' then
        perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'bounced', v_n);
      end if;
    when 'complaint' then perform mail.bump_usage(v_email.account_id, mail.lagos_day(v_at), 'complained', v_n);
    else null;
  end case;

  -- §7.5: the account's list mirrors its tenant's (bounces and complaints).
  v_reason := case
                when p_event = 'complaint' then 'complaint'
                when p_event = 'bounce' and coalesce(p_detail ->> 'bounceType', '') = 'Permanent' then 'bounce'
              end;
  if v_reason is not null then
    insert into mail.suppressions as s (account_id, address, reason, source, ses_address)
    select v_email.account_id, lower(a.addr), v_reason, 'ses', case when a.addr <> lower(a.addr) then a.addr end
      from (select distinct on (lower(btrim(x))) btrim(x) as addr
              from unnest(coalesce(p_suppress, '{}')) x
             where x is not null) a
     where char_length(a.addr) <= 320 and lower(a.addr) ~ '^[^@\s<>]+@[^@\s<>]+$'
       and lower(a.addr) in (select mail.address_of(m)
                               from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m)
    on conflict (account_id, address) do update set ses_address = coalesce(s.ses_address, excluded.ses_address);
  end if;

  -- §6: the customer's webhooks.
  v_hook := case p_event
              when 'send' then 'email.sent'
              when 'delivery' then 'email.delivered'
              when 'delivery_delay' then 'email.delivery_delayed'
              when 'bounce' then 'email.bounced'
              when 'complaint' then 'email.complained'
            end;
  if v_hook is not null then
    v_extra := case p_event
                 when 'bounce' then jsonb_build_object('bounce', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'bounceType', 'sub_type', v_detail ->> 'bounceSubType',
                   'diagnostic', v_detail ->> 'diagnosticCode')))
                 when 'complaint' then jsonb_build_object('complaint', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'complaintFeedbackType', 'sub_type', v_detail ->> 'complaintSubType')))
                 when 'delivery_delay' then jsonb_build_object('delay', jsonb_strip_nulls(jsonb_build_object(
                   'type', v_detail ->> 'delayType')))
                 else '{}'::jsonb
               end;
    perform mail.queue_webhook_event(v_email.account_id, v_hook, mail.email_webhook_data(v_email, v_extra),
                                     v_at, v_email.id);
  end if;
  return true;
end;
$$;

revoke all on function mail.record_send_event(text, text, uuid, text, timestamptz, jsonb, integer, text[])
  from public, anon, authenticated, service_role;
grant execute on function mail.record_send_event(text, text, uuid, text, timestamptz, jsonb, integer, text[])
  to service_role;
