import { usdToCents } from '@dr/shared/admin'

/**
 * What an order costs us at the supplier — the figure the float pre-flight
 * compares with our balance (FR-C8), and what each line's cost is recorded as
 * (`order_item_costs`, ADMIN-SPEC §6, D13). One rule per kind of line, the
 * same as the price the customer sees (periodTotalKobo, renewalTotalKobo):
 *
 * - a registration: the first term at the registration rate for each of its
 *   years, later years at the renewal rate — one year for most extensions,
 *   two for .ai; the catalogue sync offers a period only where the
 *   supplier's listed price for it is exactly this;
 * - a renewal: the renewal rate for each year;
 * - a transfer: the transfer price, once;
 * - an SSL certificate: the supplier's price for the product (FR-SSL-6);
 *
 * plus the ICANN fee per year (once for a transfer) on generic extensions.
 *
 * Every amount is integer cents (N5, D24). A `*_usd` value is read as decimal
 * text — `numeric::text`, or a number's own digits — multiplied and added
 * exactly, and rounded once at the cent by `usdToCents`: a four-place rate
 * times two years is never rounded before it is doubled. The pre-flight
 * total is the sum of the lines, so what each line records adds up to the
 * cent to what the float was checked against.
 */

/** A `*_usd` column as read: its text (`register_usd::text`), or a number. */
export type UsdAmount = number | string

export type SupplierCost = {
  registerUsd: UsdAmount
  renewUsd: UsdAmount
  isCountryCode: boolean
  /** The shortest registration the registry sells, in years. */
  firstTermYears: number
}

/** One line's cost: the supplier's price, and the ICANN fee modelled apart. */
export type LineCost = { supplierCents: number; icannCents: number }

export type CostLine =
  | { kind: 'register'; tld: string; periodYears: number; cost: SupplierCost }
  | { kind: 'renew'; years: number; renewUsd: UsdAmount; isCountryCode: boolean }
  | { kind: 'transfer'; transferUsd: UsdAmount; isCountryCode: boolean }
  | { kind: 'ssl'; productCode: string; createUsd: UsdAmount | null | undefined }

/** Places carried before the one rounding: more than any price column holds (numeric(12,4)). */
const PLACES = 10
const UNIT = 10n ** BigInt(PLACES)

/** A non-negative USD amount as an exact count of 10⁻¹⁰ dollars. Anything else throws. */
function exact(value: UsdAmount): bigint {
  let text = ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    text = /e/i.test(String(value)) ? value.toFixed(PLACES) : String(value)
  } else if (typeof value === 'string') {
    text = value.trim()
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || (!match[1] && !match[2])) throw new Error('Not a USD amount')
  const fraction = (match[2] ?? '').slice(0, PLACES).padEnd(PLACES, '0')
  return BigInt(match[1] || '0') * UNIT + BigInt(fraction)
}

/** Exact dollars to integer cents, rounded at the cent the shared way (half away from zero). */
function toCents(amount: bigint): number {
  return usdToCents(`${amount / UNIT}.${(amount % UNIT).toString().padStart(PLACES, '0')}`)
}

function years(count: number, what: string): bigint {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`${what} is not sold for ${count} years`)
  return BigInt(count)
}

/** What one line costs us, in integer cents, with the ICANN fee split out. */
export function lineCostUsd(line: CostLine, icannFeeUsd: UsdAmount): LineCost {
  const icannPerYear = exact(icannFeeUsd)
  switch (line.kind) {
    case 'register': {
      const { cost, periodYears } = line
      const total = years(periodYears, `.${line.tld}`)
      const first = years(cost.firstTermYears, `.${line.tld}`)
      if (total < first) throw new Error(`.${line.tld} is not sold for ${periodYears} years`)
      return {
        supplierCents: toCents(
          exact(cost.registerUsd) * first + exact(cost.renewUsd) * (total - first),
        ),
        icannCents: cost.isCountryCode ? 0 : toCents(icannPerYear * total),
      }
    }
    case 'renew': {
      const count = years(line.years, 'A renewal')
      return {
        supplierCents: toCents(exact(line.renewUsd) * count),
        icannCents: line.isCountryCode ? 0 : toCents(icannPerYear * count),
      }
    }
    case 'transfer':
      return {
        supplierCents: toCents(exact(line.transferUsd)),
        icannCents: line.isCountryCode ? 0 : toCents(icannPerYear),
      }
    case 'ssl': {
      // A product with no cost is not sold — refused rather than checked against a guess (N5b).
      const price = line.createUsd ?? null
      const cents = price === null ? 0 : toCents(exact(price))
      if (cents <= 0) throw new Error(`No supplier cost for SSL product ${line.productCode}`)
      return { supplierCents: cents, icannCents: 0 }
    }
  }
}

/** Each registration line's cost, in the order given. An extension with no cost throws. */
export function wholesaleCostUsd(
  lines: readonly { tld: string; periodYears: number }[],
  costs: ReadonlyMap<string, SupplierCost>,
  icannFeeUsd: UsdAmount,
): LineCost[] {
  return lines.map((line) => {
    const cost = costs.get(line.tld)
    if (!cost) throw new Error(`No supplier cost for .${line.tld}`)
    return lineCostUsd(
      { kind: 'register', tld: line.tld, periodYears: line.periodYears, cost },
      icannFeeUsd,
    )
  })
}

/** Each SSL certificate's cost, from `ssl_products.create_usd` (FR-SSL-6, FR-C8). */
export function sslCostUsd(
  lines: readonly { productCode: string }[],
  costs: ReadonlyMap<string, UsdAmount | null>,
): LineCost[] {
  return lines.map((line) =>
    lineCostUsd(
      { kind: 'ssl', productCode: line.productCode, createUsd: costs.get(line.productCode) },
      0,
    ),
  )
}

/** The float pre-flight's total: every line's supplier price and ICANN fee, in cents. */
export function totalCents(costs: readonly LineCost[]): number {
  return costs.reduce((sum, cost) => sum + cost.supplierCents + cost.icannCents, 0)
}

export type OrderItemCostRow = {
  order_item_id: string
  supplier_cost_cents: number
  icann_fee_cents: number
}

/** `order_item_costs` rows: each line id with its cost, position by position. */
export function costRows(
  lineIds: readonly string[],
  costs: readonly LineCost[],
): OrderItemCostRow[] {
  return lineIds.flatMap((id, index) => {
    const cost = costs[index]
    return cost
      ? [
          {
            order_item_id: id,
            supplier_cost_cents: cost.supplierCents,
            icann_fee_cents: cost.icannCents,
          },
        ]
      : []
  })
}
