/**
 * Flutterwave's processing fee is paid by the customer (owner's decision, 24
 * Sept 2026): Flutterwave adds it on its own payment page, on top of our
 * total. FR-C5 and N9b — said wherever a total is paid, and refunds return
 * the order amount only, since that is what we received.
 */
export const PROCESSING_FEE_NOTE =
  'Flutterwave adds its own processing fee on its payment page, so the amount charged there is a little more than this total.'
