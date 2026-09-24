-- ─────────────────────────────────────────────────────────────────────────────
-- A renewal job belongs to its order line, as a registration does.
--
-- Migration 13 allowed an order line only on registration jobs, so the
-- renewal jobs migration 23 queues were refused and a paid renewal could not
-- be recorded. Found by renewal.db.test.ts before any renewal was sold.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.jobs drop constraint jobs_check;
alter table public.jobs add constraint jobs_check
  check ((kind in ('register_domain', 'renew_domain')) = (order_item_id is not null));
