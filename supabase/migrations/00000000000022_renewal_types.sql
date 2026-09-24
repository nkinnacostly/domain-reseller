-- ─────────────────────────────────────────────────────────────────────────────
-- Renewals (PRD E8, FR-RN1): the new values their queue and refunds need.
-- On their own because Postgres will not use an enum value in the
-- transaction that adds it; migration 23 uses them.
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.job_kind add value if not exists 'renew_domain';
alter type public.refund_reason add value if not exists 'renewal_failed';
