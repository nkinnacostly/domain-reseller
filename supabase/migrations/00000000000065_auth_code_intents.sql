-- A transfer code is read only for its owner's own, fresh request (security
-- audit, 8 Oct 2026: medium). The gateway's GET /v1/domains/:name/auth-code
-- trusted the shared gateway secret alone: whoever held it could collect the
-- code of every domain in the reseller account, with no two-factor, no
-- owner and no record. The admin routes already bind each read to an audited
-- note (D22); now the customer's read is bound too.
--
--   1. The web, after its own checks (ownership, a fresh second factor —
--      SEC-2), asks request_auth_code_intent as the person. SQL checks again:
--      signed in at aal2, the domain theirs. It answers a one-use id.
--   2. The web sends that id to the gateway (X-Intent-Id). The gateway claims
--      it (claim_auth_code_intent, service role): unused, under 60 seconds
--      old, for this domain name and side, and the domain still the person's.
--      No claim, no registry read.
--
-- Nobody but these two functions writes the table: not the service role
-- either, so the gateway secret and the service key together still cannot
-- mint an intent. Intents are kept a day, then purged as new ones are made.

create table public.auth_code_intents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  domain_id    uuid not null references public.domains (id) on delete cascade,
  domain_name  text not null check (char_length(domain_name) between 3 and 253),
  side         text not null check (side in ('live', 'sandbox')),
  created_at   timestamptz not null default now(),
  used_at      timestamptz
);
create index auth_code_intents_created on public.auth_code_intents (created_at);

alter table public.auth_code_intents enable row level security;
revoke all on public.auth_code_intents from public, anon, authenticated, service_role;

create function public.request_auth_code_intent(p_domain_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_domain public.domains;
  v_id     uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  -- A transfer code needs two-factor authentication (SEC-2): an aal2 session.
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object('ok', false, 'code', 'mfa_required');
  end if;
  select * into v_domain from public.domains d where d.id = p_domain_id and d.user_id = v_user;
  if v_domain.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  delete from public.auth_code_intents where created_at < now() - interval '1 day';
  insert into public.auth_code_intents (user_id, domain_id, domain_name, side)
  values (v_user, v_domain.id, lower(v_domain.domain_name::text),
          case when v_domain.test_mode then 'sandbox' else 'live' end)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'intentId', v_id);
end;
$$;

create function public.claim_auth_code_intent(p_intent_id uuid, p_domain_name text, p_side text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.auth_code_intents i
     set used_at = now()
   where i.id = p_intent_id
     and i.used_at is null
     and i.created_at > now() - interval '60 seconds'
     and i.domain_name = lower(coalesce(p_domain_name, ''))
     and i.side = p_side
     and exists (select 1 from public.domains d
                  where d.id = i.domain_id and d.user_id = i.user_id
                    and lower(d.domain_name::text) = i.domain_name)
  returning i.id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.request_auth_code_intent(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_auth_code_intent(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.request_auth_code_intent(uuid) to authenticated;
grant execute on function public.claim_auth_code_intent(uuid, text, text) to service_role;
