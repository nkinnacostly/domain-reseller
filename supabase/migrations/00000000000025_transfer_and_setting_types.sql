-- New job and refund kinds for transfers in and registry-side settings.
-- A new enum value cannot be used in the transaction that adds it, so these
-- come in their own migration, ahead of the functions that use them (26).

alter type public.job_kind add value if not exists 'transfer_domain';
alter type public.job_kind add value if not exists 'set_transfer_lock';
alter type public.job_kind add value if not exists 'set_privacy';
alter type public.job_kind add value if not exists 'update_contacts';

alter type public.refund_reason add value if not exists 'transfer_failed';
