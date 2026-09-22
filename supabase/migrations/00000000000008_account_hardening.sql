-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts (PRD E2): lock down what a user may change about themselves, and
-- record the facts account security decisions depend on.
-- ─────────────────────────────────────────────────────────────────────────────

-- The "update own" policy decides WHICH row a user may touch; column
-- privileges decide WHAT. Without this, a signed-in user could set their own
-- kyc_status or risk_score through the API. They may edit their contact
-- details and nothing else.
revoke update on public.profiles from authenticated, anon;
grant update (full_name, phone, account_type, business_name, tax_id)
  on public.profiles to authenticated;

-- FR-A6: sensitive operations are held for 24 hours after a password reset.
-- Written only server-side (the recovery-link handler, with the secret key),
-- never by the user — the grant above leaves it out on purpose.
alter table public.profiles add column password_reset_at timestamptz;

comment on column public.profiles.password_reset_at is
  'Set when a password is reset through the recovery link. Sensitive operations are held for 24h after (PRD FR-A6, SEC-3).';

-- Keep profiles.email in step with the login email once a change is confirmed.
create or replace function public.handle_user_email_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_changed();
