-- Two-factor authentication enforced on the data, not only the pages
-- (security audit, 8 Oct 2026: high). Until now only the apps' proxies sent
-- a half-signed-in session (password entered, code not yet) to /verify. The
-- REST API answered that session in full: anyone holding only a customer's
-- password could call /rest/v1 directly — read the shop's orders and contact
-- profiles, mint a Mail API key, read 72 hours of email bodies.
--
-- PostgREST runs `db_pre_request` before every request, after it has set the
-- request's role and JWT claims. This one refuses (HTTP 403) a signed-in
-- user who has a verified second factor but whose token is not aal2 — the
-- rule Supabase documents for MFA, applied once for every table, view and
-- function in every exposed schema (public, mail), so no policy or function
-- can forget it. Everyone else passes untouched: anon, service_role (the
-- apps' servers, the gateway, the worker), and people without two-factor.
--
-- One call is allowed before the code: admin_status, which the proxies ask
-- to send an administrator to /verify (it tells the caller only about
-- themselves). Signing in itself (/auth/v1) never passes through here.
--
-- A bad token cannot make this function fail for others: every cast is
-- guarded, and anything it cannot read lets the request through to RLS as
-- before, never down.

create function public.check_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw    text := current_setting('request.jwt.claims', true);
  v_claims jsonb;
  v_sub    text;
  v_path   text := coalesce(current_setting('request.path', true), '');
begin
  if v_raw is null or v_raw = '' or left(v_raw, 1) <> '{' then
    return;
  end if;
  v_claims := v_raw::jsonb;
  if coalesce(v_claims ->> 'role', '') <> 'authenticated' or coalesce(v_claims ->> 'aal', '') = 'aal2' then
    return;
  end if;
  v_sub := coalesce(v_claims ->> 'sub', '');
  if v_sub !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return;
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = v_sub::uuid and f.status = 'verified') then
    return;
  end if;
  if v_path ~ '/rpc/admin_status$' then
    return;
  end if;
  raise sqlstate 'PT403'
    using message = 'Two-factor authentication required',
          hint = 'Enter the code from your authenticator app to finish signing in.';
end;
$$;

revoke all on function public.check_request() from public;
grant execute on function public.check_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.check_request';
notify pgrst, 'reload config';
