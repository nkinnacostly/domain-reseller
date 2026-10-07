-- MyDomainsHub Mail: adding a domain's DNS records at its DNS host for the
-- customer (docs/MAIL-SPEC.md §5.3): Cloudflare, with a token the customer
-- pastes once (never stored), or Domain Connect's one-click flow.
--
-- The app asks here first, as the person: owners, admins and developers, as
-- for every other change to a domain; a customer domain whose records SES has
-- given (pending or verified); at most ten tries an hour for one domain, so
-- our server is never a pump for someone's Cloudflare API. Each try is in the
-- account's own security log, with the host and the method, never the token.
-- The answer carries what the records are made from, read here rather than
-- trusted from the request.

create function mail.start_dns_setup(p_domain_id uuid, p_provider text, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_domain mail.domains;
  v_role   text;
  v_tries  integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'unauthorized');
  end if;
  if p_provider is distinct from 'cloudflare' or p_method not in ('token', 'domain_connect') then
    return jsonb_build_object('ok', false, 'code', 'validation');
  end if;
  select * into v_domain from mail.domains where id = p_domain_id;
  if v_domain.id is not null then
    v_role := mail.caller_role(v_domain.account_id);
  end if;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_role not in ('owner', 'admin', 'developer') or v_domain.kind <> 'customer' then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_domain.status not in ('pending', 'verified') or cardinality(v_domain.dkim_tokens) = 0 then
    return jsonb_build_object('ok', false, 'code', 'not_ready', 'status', v_domain.status);
  end if;

  -- Serialised per domain, so two tries at once cannot both pass the count.
  perform 1 from mail.domains where id = p_domain_id for update;
  select count(*) into v_tries from mail.account_audit_log l
   where l.account_id = v_domain.account_id
     and l.action = 'domain.dns_setup'
     and l.target = p_domain_id::text
     and l.at > now() - interval '1 hour';
  if v_tries >= 10 then
    return jsonb_build_object('ok', false, 'code', 'too_many');
  end if;

  insert into mail.account_audit_log (account_id, actor, actor_user_id, action, target, detail)
  values (v_domain.account_id, 'user', v_user, 'domain.dns_setup', p_domain_id::text,
          jsonb_build_object('name', v_domain.name, 'provider', p_provider, 'method', p_method));
  return jsonb_build_object('ok', true, 'domainId', v_domain.id, 'name', v_domain.name,
                            'mailFromDomain', v_domain.mail_from_domain,
                            'dkimTokens', to_jsonb(v_domain.dkim_tokens));
end;
$$;

revoke all on function mail.start_dns_setup(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function mail.start_dns_setup(uuid, text, text) to authenticated;
