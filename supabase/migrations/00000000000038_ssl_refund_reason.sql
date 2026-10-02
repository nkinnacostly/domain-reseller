-- ─────────────────────────────────────────────────────────────────────────────
-- SSL certificates (PRD E15, FR-SSL-3): the refund reason for a certificate
-- that could not be ordered from the CA.
--
-- On its own because Postgres will not use an enum value in the transaction
-- that adds it (as 22 and 25); migration 39 uses it. Apply 38, then 39.
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.refund_reason add value if not exists 'ssl_failed';
