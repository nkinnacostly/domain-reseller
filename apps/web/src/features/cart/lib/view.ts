import { formatNaira, periodTotalKobo, type TldPricing } from '@dr/shared'
import type { LineStatus, PricedLine } from './lines'

/**
 * What the cart page sends to the browser: display strings, already
 * formatted. The client does no money maths, and sees no cost or margin.
 */
export type LineView = {
  id: string
  domain: string
  tld: string
  status: LineStatus
  periodYears: number
  total: string
  renewal: string
  /** A changed line's old and new price, for the diff (FR-C4). */
  was: string | null
  heldUntil: string | null
  includesIcannFee: boolean
  privacyOffered: boolean
  privacy: boolean
  autoRenew: boolean
  periodOptions: { years: number; label: string }[]
}

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Africa/Lagos',
})

export function toLineView(line: PricedLine, pricing: TldPricing | undefined): LineView {
  const years = (count: number) => `${count} ${count === 1 ? 'year' : 'years'}`
  const periodOptions = pricing
    ? Array.from({ length: pricing.maxPeriod - pricing.minPeriod + 1 }, (_, index) => {
        const count = pricing.minPeriod + index
        return {
          years: count,
          label: `${years(count)} — ${formatNaira(periodTotalKobo(pricing, count))}`,
        }
      })
    : [{ years: line.periodYears, label: years(line.periodYears) }]

  return {
    id: line.id,
    domain: line.domain,
    tld: line.tld,
    status: line.status,
    periodYears: line.periodYears,
    total: formatNaira(line.payableKobo),
    renewal: formatNaira(line.renewalKobo),
    was: line.status === 'changed' ? formatNaira(line.quotedTotalKobo) : null,
    heldUntil: line.heldUntil ? timeFormat.format(new Date(line.heldUntil)) : null,
    includesIcannFee: line.includesIcannFee,
    privacyOffered: line.privacyOffered,
    privacy: line.privacy,
    autoRenew: line.autoRenew,
    periodOptions,
  }
}
