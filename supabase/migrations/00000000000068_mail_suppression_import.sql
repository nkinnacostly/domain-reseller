-- MyDomainsHub Mail: import a suppression list (owner, 8 Oct 2026: make
-- moving from another provider easy). Someone arriving from Resend, SendGrid,
-- Mailgun or Brevo brings the addresses that bounced, complained or
-- unsubscribed there, so this account never sends to them: the old
-- provider's reputation work is kept, and ours is not spent finding them out
-- again (MAIL-SPEC §7.5).
--
--   * The dashboard reads the file in the browser and sends the addresses a
--     chunk at a time to import_suppressions, as the person: owners and
--     admins only, as removing one is (migration 49).
--   * Each address must pass the table's own rule; the rest are counted, not
--     stored. One already on the list keeps its reason and source.
--   * Imported rows are source `customer`. They are ours alone: an address
--     never sent to is on no SES list, and removing one asks SES first, which
--     answers "not found" — removal treats that as done (deleteSuppressedDestination).
--   * Bounded: at most 5,000 addresses a call, suppression_import_daily_cap
--     added a Lagos day, and suppression_list_max on the list in all. Each
--     call is one audit row with its counts, never an address (§9).

alter table mail.settings
  add column suppression_import_daily_cap integer not null default 100000
    check (suppression_import_daily_cap between 1 and 1000000),
  add column suppression_list_max integer not null default 1000000
    check (suppression_list_max between 1 and 10000000);

create function mail.import_suppressions(p_account_id uuid, p_addresses text[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_role     text;
  v_state    text;
  v_settings mail.settings;
  v_given    integer := coalesce(cardinality(p_addresses), 0);
  v_valid    text[];
  v_invalid  integer;
  v_today    integer;
  v_total    integer;
  v_added    integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  v_role := mail.caller_role(p_account_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  -- One import at a time per account, so the day's count and the list's size hold.
  select a.state into v_state from mail.accounts a where a.id = p_account_id for update;
  if v_state = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'account_closed');
  end if;
  if coalesce(p_reason, '') not in ('bounce', 'complaint', 'manual') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'reason');
  end if;
  if v_given not between 1 and 5000 then
    return jsonb_build_object('ok', false, 'code', 'validation', 'field', 'addresses');
  end if;

  -- The table's rule (migration 44), and no longer than SES keeps (migration 49).
  -- Valid ones once each; invalid ones counted (a repeat of a valid one is neither).
  select coalesce(array_agg(distinct a), '{}'), v_given - count(*)::integer
    into v_valid, v_invalid
    from (select lower(btrim(x)) as a from unnest(p_addresses) x) t
   where char_length(a) <= 320 and a ~ '^[^@\s<>]+@[^@\s<>]+$';

  select * into v_settings from mail.settings s where s.id;
  select coalesce(sum((l.detail ->> 'added')::integer), 0) into v_today
    from mail.account_audit_log l
   where l.account_id = p_account_id and l.action = 'suppressions.imported'
     and l.at >= (mail.lagos_day(now())::timestamp at time zone 'Africa/Lagos');
  if v_today + cardinality(v_valid) > v_settings.suppression_import_daily_cap then
    return jsonb_build_object('ok', false, 'code', 'import_limit', 'per', 'day',
                              'max', v_settings.suppression_import_daily_cap, 'added', v_today);
  end if;
  select count(*)::integer into v_total from mail.suppressions s where s.account_id = p_account_id;
  if v_total + cardinality(v_valid) > v_settings.suppression_list_max then
    return jsonb_build_object('ok', false, 'code', 'import_limit', 'per', 'list',
                              'max', v_settings.suppression_list_max, 'added', v_total);
  end if;

  with inserted as (
    insert into mail.suppressions (account_id, address, reason, source)
    select p_account_id, a, p_reason, 'customer' from unnest(v_valid) a
    on conflict (account_id, address) do nothing
    returning 1
  )
  select count(*)::integer into v_added from inserted;

  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (p_account_id, 'user', v_user, 'suppressions.imported', null,
          jsonb_build_object('reason', p_reason, 'added', v_added,
                             'already', cardinality(v_valid) - v_added, 'invalid', v_invalid));
  return jsonb_build_object('ok', true, 'added', v_added,
                            'already', cardinality(v_valid) - v_added, 'invalid', v_invalid);
end;
$$;

revoke all on function mail.import_suppressions(uuid, text[], text) from public, anon, authenticated, service_role;
grant execute on function mail.import_suppressions(uuid, text[], text) to authenticated;
