-- Two refund reasons for the payment guards in migration 62 (security audit,
-- 8 Oct 2026), apart so they can be used there: a new enum value cannot be
-- used in the transaction that adds it.
--
--   late_payment  a charge for an order placed longer ago than its grace:
--                 its price, exchange rate and float check are stale (N4, I3)
--   over_limit    a charge that would take the account past its daily limit
--                 on new domains (SEC-11): a cancelled order paid later

alter type public.refund_reason add value if not exists 'late_payment';
alter type public.refund_reason add value if not exists 'over_limit';

-- How long after an order is placed a payment is still applied: long enough
-- for a slow bank transfer, short enough that its prices still hold.
alter table public.ops_settings
  add column late_payment_grace_hours integer not null default 48
    check (late_payment_grace_hours between 1 and 720);

-- And the incident a person reads for each (the admin's payments view).
alter table public.payment_incidents drop constraint payment_incidents_kind_check;
alter table public.payment_incidents add constraint payment_incidents_kind_check check (kind in (
  'underpayment',
  'tx_ref_mismatch',
  'currency_mismatch',
  'unrecorded_payment',
  'refund_not_created',
  'mode_mismatch',
  'registered_after_refund',
  'late_payment',             -- paid after late_payment_grace_hours: refunded whole
  'over_limit'                -- a cancelled order paid past the daily limit: refunded whole
));
