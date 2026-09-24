-- Per-domain hosts at checkout, and the other three contacts (24 Sept 2026).
--
-- FR-C10: a checkout's nameserver choice applies to the whole order by
-- default, with a per-domain override for mixed carts. A line's own
-- `nameservers` (and the preset they came from) win over the order's.
--
-- FR-A4, FR-DS1: a domain has four contacts. The registrant stays where it
-- was (`registrant`); the administrative, technical and billing contacts live
-- in `contacts` — {"administrative": {...}, "technical": {...}, "billing": {...}},
-- each a Contact like the registrant. A role left out is held by the
-- registrant, which is what every domain registered so far has. Orders carry
-- the same shape (`orders.contacts`) into the domain when they are paid; a
-- change on the Contacts tab is a pending value applied by the
-- `update_contacts` job, which records what the registry holds for all four.

alter table public.order_items
  add column nameservers text[],
  add column nameserver_preset_id uuid references public.nameserver_presets (id) on delete set null,
  add constraint order_items_nameservers_check
    check (nameservers is null or (cardinality(nameservers) between 2 and 13)),
  add constraint order_items_nameservers_register_only
    check (nameservers is null or item_type = 'register');

comment on column public.order_items.nameservers is
  'FR-C10: this domain''s own nameservers, overriding the order''s. Registrations only.';

alter table public.orders
  add column contacts jsonb check (contacts is null or jsonb_typeof(contacts) = 'object');

comment on column public.orders.contacts is
  'Administrative, technical and billing contacts for this order''s domains. A role left out is the registrant.';

alter table public.domains
  add column contacts jsonb check (contacts is null or jsonb_typeof(contacts) = 'object'),
  add column pending_contacts jsonb check (pending_contacts is null or jsonb_typeof(pending_contacts) = 'object');

comment on column public.domains.contacts is
  'Administrative, technical and billing contacts as the registry holds them. A role left out is the registrant.';
comment on column public.domains.pending_contacts is
  'The other three contacts asked for and not yet confirmed by the registry. Null: none. An empty object: all back to the registrant.';

create or replace function public.record_order_payment(
  p_order_id           uuid,
  p_provider_reference text,
  p_amount_kobo        bigint,
  p_currency           text,
  p_method             text,
  p_raw                jsonb
)
returns public.order_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order      public.orders%rowtype;
  v_payment_id uuid;
  v_owner      uuid;
  v_items      integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id;
  end if;
  if p_currency <> 'NGN' then
    raise exception 'order % is paid in naira only', v_order.order_number;
  end if;
  if p_amount_kobo < v_order.total_kobo then
    raise exception 'a charge below the total does not pay order %', v_order.order_number;
  end if;

  insert into public.payments (
    order_id, user_id, provider, provider_reference, tx_ref,
    amount_kobo, currency, status, method, raw
  ) values (
    v_order.id, v_order.user_id, 'flutterwave', p_provider_reference, v_order.tx_ref,
    p_amount_kobo, p_currency, 'successful', p_method, p_raw
  )
  on conflict (provider_reference) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    -- Seen before: the redirect and the webhook both arrive, in any order.
    select order_id into v_owner from public.payments where provider_reference = p_provider_reference;
    if v_owner <> v_order.id then
      raise exception 'charge % belongs to another order', p_provider_reference;
    end if;
    return v_order.status;
  end if;

  if v_order.status in ('awaiting_payment', 'cancelled') then
    -- CMP-17: the invoice number is taken with the payment, in one transaction.
    update public.orders
       set status = 'paid', paid_at = now(), payment_id = v_payment_id,
           invoice_number = coalesce(
             invoice_number,
             case when test_mode
               then 'TEST-INV-' || lpad(nextval('public.test_invoice_number_seq')::text, 6, '0')
               else 'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
             end)
     where id = v_order.id;

    delete from public.cart_items ci
      using public.carts c
     where ci.cart_id = c.id
       and c.user_id = v_order.user_id
       and ci.domain in (select domain from public.order_items where order_id = v_order.id);

    -- A registration or a transfer brings a new domain onto the account. A
    -- transfer keeps the nameservers it has at the registry.
    insert into public.domains (
      user_id, domain_name, tld, source, test_mode, order_item_id, local_status,
      auto_renew, privacy_enabled, pending_nameservers, nameserver_preset_id, registrant, contacts
    )
    select v_order.user_id, oi.domain, oi.tld,
           case oi.item_type when 'transfer' then 'transfer' else 'registration' end,
           v_order.test_mode, oi.id,
           (case oi.item_type when 'transfer' then 'transfer_requested' else 'pending' end)::public.domain_status,
           oi.auto_renew, oi.privacy,
           -- FR-C10: a line's own nameservers override the order's.
           case when oi.item_type = 'transfer' then null
                else coalesce(oi.nameservers, v_order.nameservers) end,
           case when oi.item_type = 'transfer' then null
                when oi.nameservers is not null then oi.nameserver_preset_id
                else v_order.nameserver_preset_id end,
           v_order.registrant,
           v_order.contacts
      from public.order_items oi
     where oi.order_id = v_order.id
       and oi.item_type in ('register', 'transfer')
    on conflict (order_item_id) do nothing;

    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'order_paid', 'system', jsonb_build_object('order_number', v_order.order_number)
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id;

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select (case oi.item_type when 'transfer' then 'transfer_domain' else 'register_domain' end)::public.job_kind,
           (case oi.item_type when 'transfer' then 'transfer:' else 'register:' end) || d.order_item_id,
           d.id, d.order_item_id, d.test_mode
      from public.domains d
      join public.order_items oi on oi.id = d.order_item_id
     where oi.order_id = v_order.id
    on conflict (idempotency_key) do nothing;

    -- A renewal line renews the domain it names: the account's own, on the
    -- same side (test or live) as the order. Anything else is not renewed,
    -- and its line fails below so it is refunded.
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    select d.id, 'renewal_paid', 'system',
           jsonb_build_object('order_number', v_order.order_number, 'years', oi.period_years)
      from public.order_items oi
      join public.domains d on d.id = oi.domain_id
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and d.user_id = v_order.user_id
       and d.test_mode = v_order.test_mode;

    insert into public.jobs (kind, idempotency_key, domain_id, order_item_id, test_mode)
    select 'renew_domain', 'renew:' || oi.id, d.id, oi.id, d.test_mode
      from public.order_items oi
      join public.domains d on d.id = oi.domain_id
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and d.user_id = v_order.user_id
       and d.test_mode = v_order.test_mode
    on conflict (idempotency_key) do nothing;

    update public.order_items oi
       set status = 'failed', failure_code = 'NOT_RENEWABLE'
     where oi.order_id = v_order.id
       and oi.item_type = 'renew'
       and not exists (
         select 1 from public.domains d
          where d.id = oi.domain_id
            and d.user_id = v_order.user_id
            and d.test_mode = v_order.test_mode
       );

    -- Queue the refund of any renewal line that could not be queued.
    perform public.enqueue_line_refund(oi.id)
       from public.order_items oi
      where oi.order_id = v_order.id and oi.item_type = 'renew' and oi.status = 'failed';

    select count(*) into v_items from public.order_items where order_id = v_order.id;
    if v_items = 0 then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'empty_order', p_amount_kobo, 0);
      update public.orders set status = 'failed' where id = v_order.id;
      return 'failed';
    end if;
    if p_amount_kobo > v_order.total_kobo then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, 'overpayment',
                                    p_amount_kobo - v_order.total_kobo, 0);
    end if;
    return 'paid';
  end if;

  -- A second charge for an order already paid: every kobo of it goes back.
  perform public.enqueue_refund(v_order.id, v_payment_id, null, 'duplicate_charge', p_amount_kobo, 0);
  return v_order.status;
end;
$$;

create or replace function public.claim_job(
  p_worker        text,
  p_test_mode     boolean,
  p_lease_seconds integer default 300,
  p_job_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.jobs%rowtype;
  v_context jsonb;
begin
  select * into v_job
    from public.jobs j
   where j.test_mode = p_test_mode
     and (p_job_id is null or j.id = p_job_id)
     and (
       (j.status = 'queued' and j.run_after <= now())
       or (j.status = 'running' and j.locked_at < now() - make_interval(secs => p_lease_seconds))
     )
   order by j.run_after
   limit 1
   for update skip locked;

  if not found then
    return null;
  end if;

  update public.jobs
     set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1
   where id = v_job.id
  returning * into v_job;

  if v_job.kind in ('register_domain', 'renew_domain', 'transfer_domain') then
    update public.order_items set status = 'provisioning'
     where id = v_job.order_item_id and status = 'pending';
    update public.orders o set status = 'provisioning'
      from public.order_items oi
     where oi.id = v_job.order_item_id and o.id = oi.order_id and o.status = 'paid';
  end if;

  select jsonb_build_object(
           'id', v_job.id,
           'kind', v_job.kind,
           'attempts', v_job.attempts,
           'test_mode', v_job.test_mode,
           'domain_id', d.id,
           'domain_name', d.domain_name,
           'source', d.source,
           'local_status', d.local_status,
           'privacy', d.privacy_enabled,
           'transfer_lock', d.transfer_lock,
           'registrant', d.registrant,
           'pending_nameservers', d.pending_nameservers,
           'pending_transfer_lock', d.pending_transfer_lock,
           'pending_privacy', d.pending_privacy,
           'pending_registrant', d.pending_registrant,
           -- FR-DS1: the other three roles; a missing role is the registrant (migration 29).
           'contacts', d.contacts,
           'pending_contacts', d.pending_contacts,
           'period_years', oi.period_years,
           'registered_at', d.registered_at,
           'expires_at', d.expires_at,
           -- A renewal's registry expiry, read just before its first Renew call (migration 23).
           'baseline_expiry', v_job.baseline_expiry,
           -- A transfer: when the registry accepted the request (migration 26).
           'submitted_at', v_job.submitted_at,
           -- Only a transfer job carries the code, and only until it is submitted.
           'auth_code', case when v_job.kind = 'transfer_domain' then ts.auth_code end,
           -- Confirmed with Flutterwave before anything is registered, renewed or transferred.
           'payment', case when v_job.kind in ('register_domain', 'renew_domain', 'transfer_domain')
             then jsonb_build_object(
               'order_tx_ref', o.tx_ref,
               'order_total_kobo', o.total_kobo,
               'reference', p.provider_reference,
               'amount_kobo', p.amount_kobo,
               'currency', p.currency,
               'status', p.status
             ) end
         )
    into v_context
    from public.domains d
    left join public.order_items oi on oi.id = v_job.order_item_id
    left join public.orders o on o.id = oi.order_id
    left join public.payments p on p.id = o.payment_id
    left join public.transfer_secrets ts on ts.order_item_id = v_job.order_item_id
   where d.id = v_job.domain_id;

  return v_context;
end;
$$;

create or replace function public.fail_job(
  p_job_id          uuid,
  p_code            text,
  p_message         text,
  p_needs_attention boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.jobs%rowtype;
  v_order_id uuid;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  if p_needs_attention then
    update public.jobs
       set status = 'needs_attention', last_error_code = p_code, last_error = left(p_message, 500),
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id,
            case v_job.kind
              when 'register_domain' then 'registration_delayed'
              when 'renew_domain' then 'renewal_delayed'
              when 'transfer_domain' then 'transfer_delayed'
              when 'set_transfer_lock' then 'transfer_lock_delayed'
              when 'set_privacy' then 'privacy_delayed'
              when 'update_contacts' then 'contacts_delayed'
              else 'nameservers_delayed'
            end,
            'system', jsonb_build_object('code', p_code));
    return;
  end if;

  update public.jobs
     set status = 'failed', finished_at = now(), last_error_code = p_code,
         last_error = left(p_message, 500), locked_by = null, locked_at = null
   where id = v_job.id;

  if v_job.kind = 'register_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    update public.domains set local_status = 'registration_failed', pending_nameservers = null
     where id = v_job.domain_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'registration_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind = 'renew_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'renewal_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind = 'transfer_domain' then
    update public.order_items set status = 'failed', failure_code = p_code
     where id = v_job.order_item_id
    returning order_id into v_order_id;
    -- Refused before the registry had it: cancelled. Refused after: rejected.
    update public.domains
       set local_status = case when local_status = 'transfer_pending'
                            then 'transfer_rejected'::public.domain_status
                            else 'transfer_cancelled'::public.domain_status end
     where id = v_job.domain_id
       and local_status in ('transfer_requested', 'transfer_pending');
    delete from public.transfer_secrets where order_item_id = v_job.order_item_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'transfer_failed', 'system', jsonb_build_object('code', p_code));
    perform public.enqueue_line_refund(v_job.order_item_id);
    perform public.settle_order(v_order_id);
  elsif v_job.kind in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    -- Given up: the domain stops saying a change is on its way.
    update public.domains
       set pending_transfer_lock = case when v_job.kind = 'set_transfer_lock' then null else pending_transfer_lock end,
           pending_privacy = case when v_job.kind = 'set_privacy' then null else pending_privacy end,
           pending_registrant = case when v_job.kind = 'update_contacts' then null else pending_registrant end,
           pending_contacts = case when v_job.kind = 'update_contacts' then null else pending_contacts end
     where id = v_job.domain_id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id,
            case v_job.kind
              when 'set_transfer_lock' then 'transfer_lock_not_applied'
              when 'set_privacy' then 'privacy_not_applied'
              else 'contacts_not_applied'
            end,
            'system', jsonb_build_object('code', p_code));
  else
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, 'nameservers_not_applied', 'system', jsonb_build_object('code', p_code));
  end if;
end;
$$;

create or replace function public.enqueue_domain_change(p_domain_id uuid, p_kind public.job_kind)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    raise exception '% is not a domain setting', p_kind;
  end if;

  insert into public.jobs (kind, idempotency_key, domain_id, test_mode)
  select p_kind, p_kind::text || ':' || d.id || ':' || extensions.gen_random_uuid(), d.id, d.test_mode
    from public.domains d
   where d.id = p_domain_id
     and d.source <> 'demo'
     and d.local_status in ('active', 'expired_grace')
     and case p_kind
           when 'set_transfer_lock' then d.pending_transfer_lock is not null
           when 'set_privacy' then d.pending_privacy is not null
           else d.pending_registrant is not null or d.pending_contacts is not null
         end
  on conflict (domain_id, kind)
     where kind in ('set_transfer_lock', 'set_privacy', 'update_contacts')
       and status in ('queued', 'running', 'needs_attention')
  do nothing;
end;
$$;

create or replace function public.record_domain_change(
  p_job_id    uuid,
  p_attempted jsonb,
  p_applied   jsonb,
  p_code      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.jobs%rowtype;
  v_setting text;
  v_domain  public.domains%rowtype;
  v_still   boolean;
begin
  if p_attempted is null then
    raise exception 'a settings change is recorded with what was asked for';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.kind not in ('set_transfer_lock', 'set_privacy', 'update_contacts') then
    raise exception 'job % is not a settings change', p_job_id;
  end if;
  if v_job.status in ('succeeded', 'failed') then
    return;
  end if;

  v_setting := case v_job.kind
                 when 'set_transfer_lock' then 'transfer_lock'
                 when 'set_privacy' then 'privacy'
                 else 'contacts'
               end;

  if p_applied is not null then
    if v_job.kind = 'set_transfer_lock' then
      if jsonb_typeof(p_applied -> 'transfer_lock') <> 'boolean' then
        raise exception 'the registry''s transfer lock is recorded as true or false';
      end if;
      update public.domains
         set transfer_lock = (p_applied ->> 'transfer_lock')::boolean,
             pending_transfer_lock = case
               when pending_transfer_lock is not distinct from (p_attempted ->> 'transfer_lock')::boolean
               then null else pending_transfer_lock end
       where id = v_job.domain_id;
    elsif v_job.kind = 'set_privacy' then
      if jsonb_typeof(p_applied -> 'privacy') <> 'boolean' then
        raise exception 'the registry''s privacy is recorded as true or false';
      end if;
      update public.domains
         set privacy_enabled = (p_applied ->> 'privacy')::boolean,
             pending_privacy = case
               when pending_privacy is not distinct from (p_attempted ->> 'privacy')::boolean
               then null else pending_privacy end
       where id = v_job.domain_id;
    else
      if jsonb_typeof(p_applied -> 'registrant') <> 'object' then
        raise exception 'the registry''s registrant is recorded as an object';
      end if;
      if coalesce(jsonb_typeof(p_applied -> 'contacts'), 'null') not in ('object', 'null') then
        raise exception 'the registry''s other contacts are recorded as an object';
      end if;
      update public.domains
         set registrant = p_applied -> 'registrant',
             -- Absent from the answer: the other roles are not read back, keep them.
             contacts = case when p_applied ? 'contacts'
                          then nullif(p_applied -> 'contacts', 'null'::jsonb)
                          else contacts end,
             pending_registrant = case
               when pending_registrant is not distinct from (p_attempted -> 'registrant')
               then null else pending_registrant end,
             pending_contacts = case
               when pending_contacts is not distinct from (p_attempted -> 'contacts')
               then null else pending_contacts end
       where id = v_job.domain_id;
    end if;

    update public.jobs
       set status = 'succeeded', finished_at = now(), locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, v_setting || '_applied', 'system',
            -- Contact details stay out of the activity log (N13).
            case when v_job.kind = 'update_contacts' then '{}'::jsonb else p_applied end);
  else
    update public.domains
       set pending_transfer_lock = case
             when v_job.kind = 'set_transfer_lock'
              and pending_transfer_lock is not distinct from (p_attempted ->> 'transfer_lock')::boolean
             then null else pending_transfer_lock end,
           pending_privacy = case
             when v_job.kind = 'set_privacy'
              and pending_privacy is not distinct from (p_attempted ->> 'privacy')::boolean
             then null else pending_privacy end,
           pending_registrant = case
             when v_job.kind = 'update_contacts'
              and pending_registrant is not distinct from (p_attempted -> 'registrant')
             then null else pending_registrant end,
           pending_contacts = case
             when v_job.kind = 'update_contacts'
              and pending_contacts is not distinct from (p_attempted -> 'contacts')
             then null else pending_contacts end
     where id = v_job.domain_id;

    update public.jobs
       set status = 'failed', finished_at = now(), last_error_code = p_code,
           locked_by = null, locked_at = null
     where id = v_job.id;
    insert into public.domain_events (domain_id, event_type, actor_type, payload)
    values (v_job.domain_id, v_setting || '_rejected', 'system', jsonb_build_object('code', p_code));
  end if;

  -- Asked again while this one ran: send the newer value.
  select * into v_domain from public.domains where id = v_job.domain_id;
  v_still := case v_job.kind
               when 'set_transfer_lock' then v_domain.pending_transfer_lock is not null
               when 'set_privacy' then v_domain.pending_privacy is not null
               else v_domain.pending_registrant is not null or v_domain.pending_contacts is not null
             end;
  if v_still then
    perform public.enqueue_domain_change(v_job.domain_id, v_job.kind);
  end if;
end;
$$;

revoke all on function public.enqueue_domain_change(uuid, public.job_kind) from public, anon, authenticated;
revoke all on function public.record_domain_change(uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.enqueue_domain_change(uuid, public.job_kind) to service_role;
grant execute on function public.record_domain_change(uuid, jsonb, jsonb, text) to service_role;
