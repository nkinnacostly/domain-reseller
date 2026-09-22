-- ─────────────────────────────────────────────────────────────────────────────
-- Merging an anonymous cart into a user's, atomically (FR-C1).
--
-- Signing in renders the next page more than once in parallel. Done from the
-- app as separate statements, one render could read the user's cart after it
-- was created but before the lines arrived, and show it empty. In one
-- transaction, with the anonymous cart row locked, a concurrent merge waits
-- for the first to commit and then finds nothing left to move.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.merge_anonymous_cart(p_token_hash text, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anon  uuid;
  v_user  uuid;
  v_moved integer := 0;
begin
  select id into v_anon
    from public.carts
   where anon_token_hash = p_token_hash
     for update;
  if v_anon is null then
    return 0;
  end if;

  -- A session can outlive its account for a few minutes; keep the cart.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return 0;
  end if;

  insert into public.carts (user_id) values (p_user_id)
    on conflict (user_id) do nothing;
  select id into v_user from public.carts where user_id = p_user_id;

  -- A domain already in the user's cart keeps the user's line and quote.
  insert into public.cart_items (
    cart_id, domain, tld, period_years, privacy, auto_renew,
    quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at
  )
  select v_user, domain, tld, period_years, privacy, auto_renew,
         quoted_total_kobo, quoted_renewal_kobo, quoted_fx_rate_id, quoted_at
    from public.cart_items
   where cart_id = v_anon
  on conflict (cart_id, domain) do nothing;
  get diagnostics v_moved = row_count;

  delete from public.carts where id = v_anon;
  return v_moved;
end;
$$;

comment on function public.merge_anonymous_cart(text, uuid) is
  'Moves an anonymous cart into a user''s in one transaction. Server-only (service role).';

revoke all on function public.merge_anonymous_cart(text, uuid) from public, anon, authenticated;
grant execute on function public.merge_anonymous_cart(text, uuid) to service_role;
