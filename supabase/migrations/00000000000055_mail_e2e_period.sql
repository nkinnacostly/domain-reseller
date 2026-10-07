-- MyDomainsHub Mail: move an e2e account's billing period end, for the billing
-- e2e (docs/MAIL-SPEC.md §8, §12).
--
-- Migration 54 (item 22) lets a failed renewal mark an account past due only
-- within billing_settings.failed_renewal_window_hours of its period's end; a
-- failed charge mid-period is an incident instead. The e2e subscribes and then
-- fails a renewal at once, a month from the period's end, so it needs to bring
-- the end near to exercise the past-due path. Test accounts only
-- (`mail.is_e2e_account`, migration 45), and service_role only, like the
-- other e2e helpers.

create function mail.e2e_set_period_end(p_account_id uuid, p_period_end timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(mail.is_e2e_account(p_account_id), false) then
    raise exception 'mail:not_e2e' using errcode = '42501';
  end if;
  update mail.subscriptions s
     set current_period_end = p_period_end
   where s.account_id = p_account_id
     and s.test_mode;
  if not found then
    raise exception 'mail:no_test_subscription' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function mail.e2e_set_period_end(uuid, timestamptz) from public, anon, authenticated, service_role;
grant execute on function mail.e2e_set_period_end(uuid, timestamptz) to service_role;
