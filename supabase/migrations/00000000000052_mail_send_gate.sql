-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 52: MyDomainsHub Mail — the send gate knows the sandbox sender
-- (docs/MAIL-SPEC.md §7.2, MR2).
--
-- Migration 47 gave a sandbox account its own sending address on our shared
-- sandbox identity: a `mail.domains` row of kind `sandbox` and status
-- `sandbox`, named by `mail.sandbox_domain_for(account, from)` — and only
-- while the account is in the sandbox, its tenant is ready, the shared
-- identity is verified at SES and the email is from its one address.
-- reserve_send (MB6) accepts it at queue time; this is the same rule at send
-- time (MR2: "the worker re-checks at send time"), so a sandbox email that
-- was queued is not failed as `domain_not_verified` when it is claimed —
-- and one whose account left the sandbox, or whose identity stopped being
-- verified, still is.
--
-- `send_gate` (migration 44) is replaced with that one change; it keeps its
-- signature, stays a helper no API role may call, and is asked by
-- claim_sends for every email it takes. supabase/tests/mail_send_gate.sql
-- checks it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mail.send_gate(p_email_id bigint)
returns table (status text, reason text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_email   mail.emails;
  v_account mail.accounts;
begin
  select * into v_email from mail.emails where id = p_email_id;
  select * into v_account from mail.accounts where id = v_email.account_id;
  if v_account.id is null or v_account.state not in ('sandbox', 'active') or v_account.ses_status = 'disabled'
     or v_account.tenant_ready_at is null then
    return query select 'failed'::text, 'account_paused'::text;
    return;
  end if;
  -- A verified domain of the account's own, or — in the sandbox — the
  -- account's sandbox sender, from its one address (migration 47).
  if not exists (select 1 from mail.domains d
                  where d.id = v_email.domain_id and d.account_id = v_email.account_id
                    and (d.status = 'verified'
                         or (d.status = 'sandbox'
                             and d.id = mail.sandbox_domain_for(v_email.account_id, v_email.from_address)))) then
    return query select 'failed'::text, 'domain_not_verified'::text;
    return;
  end if;
  if v_email.api_key_id is not null and exists (select 1 from mail.api_keys k
                                                 where k.id = v_email.api_key_id and k.revoked_at is not null) then
    return query select 'failed'::text, 'key_revoked'::text;
    return;
  end if;
  if exists (select 1 from mail.suppressions s
              where s.account_id = v_email.account_id
                and s.address in (select mail.address_of(m)
                                    from unnest(v_email.to_addresses || v_email.cc_addresses || v_email.bcc_addresses) m)) then
    return query select 'suppressed'::text, 'suppressed'::text;
    return;
  end if;
  return;
end;
$$;

-- Still a helper: claim_sends (security definer) asks it; no API role may.
revoke all on function mail.send_gate(bigint) from public, anon, authenticated, service_role;
