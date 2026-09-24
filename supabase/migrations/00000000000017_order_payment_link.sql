-- ─────────────────────────────────────────────────────────────────────────────
-- orders.payment_id without a foreign key.
--
-- Migration 15 made it a foreign key to payments. payments.order_id already
-- links the two tables the other way, so the API no longer knew which link an
-- embed like `orders → payments(...)` meant, and refused it — the order page
-- and the payment return could not load an order. The column stays: only
-- record_order_payment sets it, from the payment it has just inserted, and
-- live payments can never be deleted (migration 15), so it cannot dangle.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.orders drop constraint orders_payment_id_fkey;

comment on column public.orders.payment_id is
  'The charge that paid the order; set only by record_order_payment. No foreign key: payments.order_id is the link the API embeds.';
