/**
 * Money at the display edge (N5): amounts stay integer kobo everywhere else.
 * Plan prices are whole naira; an upgrade's credit and its VAT are not, so
 * kobo show only when there are some — a tax invoice states the exact sum.
 */

const WHOLE = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})
const EXACT = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 2150000 → "₦21,500"; 4479167 → "₦44,791.67"; −1333333 → "−₦13,333.33". */
export function formatKobo(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) throw new RangeError('An amount must be whole kobo')
  const size = Math.abs(kobo)
  const text = size % 100 === 0 ? WHOLE.format(size / 100) : EXACT.format(size / 100)
  return kobo < 0 ? `−${text}` : text
}

/** VAT in basis points as people read it: 750 → "7.5%". */
export function vatPercent(bps: number): string {
  return `${bps / 100}%`
}
