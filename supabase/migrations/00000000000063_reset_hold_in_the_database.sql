-- The 24-hour hold after a password reset (SEC-3, FR-A6), set by the
-- database itself (security audit, 8 Oct 2026: high). Until now only the
-- web's completePasswordReset wrote profiles.password_reset_at. Someone with
-- the inbox could open a reset link and change the password through
-- Supabase's own API (PUT /auth/v1/user), skipping the hold, then sign in
-- with the new password, add their own authenticator and reveal a transfer
-- code at once.
--
-- So a password changed within a day of a reset email starts the hold,
-- whoever changed it and however. A password changed in Settings with no
-- reset asked for starts nothing, as before. (elevatedAction now also
-- refuses any session that began from an email link.)

create function public.hold_after_reset_password()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and new.recovery_sent_at is not null
     and new.recovery_sent_at > now() - interval '24 hours' then
    update public.profiles set password_reset_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.hold_after_reset_password() from public, anon, authenticated, service_role;

create trigger on_auth_password_after_reset
  after update of encrypted_password on auth.users
  for each row execute function public.hold_after_reset_password();
