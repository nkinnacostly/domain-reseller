-- Shop payments: a late payment, or a cancelled order paid past the daily
-- limit, is refunded rather than registered (security audit, 8 Oct 2026:
-- high). record_order_payment as migration 29 left it, with the guard set
-- out in its own comment; everything else is unchanged.

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
  v_guard      public.refund_reason;
  v_recent     integer;
  v_mine       integer;
  v_max        integer;
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

  -- Security audit, 8 Oct 2026. A live order's price, exchange rate and
  -- float check are from when it was placed, and its daily-limit check
  -- (SEC-11) counted only orders not cancelled. So a payment applies only:
  --   * within late_payment_grace_hours of the order (else: late_payment);
  --   * to a cancelled order, only while the account's new domains paid in
  --     the last 24 hours, with this order's, stay within its limit (else:
  --     over_limit) — cancelling and paying later cannot beat the limit.
  -- The money is kept as a payment row and refunded whole; nothing is
  -- registered, and the order is failed.
  if not v_order.test_mode and v_order.status in ('awaiting_payment', 'cancelled') then
    if v_order.created_at < now() - make_interval(hours => (select s.late_payment_grace_hours from public.ops_settings s)) then
      v_guard := 'late_payment';
    elsif v_order.status = 'cancelled' then
      select count(*) into v_mine from public.order_items oi
       where oi.order_id = v_order.id and oi.item_type in ('register', 'transfer');
      if v_mine > 0 then
        select count(*) into v_recent
          from public.order_items oi
          join public.orders o on o.id = oi.order_id
         where o.user_id = v_order.user_id and o.test_mode = false and o.id <> v_order.id
           and o.paid_at > now() - interval '24 hours'
           and o.status not in ('failed')
           and oi.item_type in ('register', 'transfer');
        v_max := coalesce((public.account_domain_allowance(v_order.user_id, false) ->> 'max')::integer, 0);
        if v_recent + v_mine > v_max then
          v_guard := 'over_limit';
        end if;
      end if;
    end if;
    if v_guard is not null then
      perform public.enqueue_refund(v_order.id, v_payment_id, null, v_guard, p_amount_kobo, 0);
      update public.orders set status = 'failed', payment_id = v_payment_id where id = v_order.id;
      insert into public.payment_incidents (test_mode, kind, order_id, detail)
      values (false, v_guard::text, v_order.id,
              jsonb_build_object('amount_kobo', p_amount_kobo, 'order_number', v_order.order_number))
      on conflict do nothing;
      return 'failed';
    end if;
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
