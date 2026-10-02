/**
 * What an order costs us at the supplier, in USD — the figure the float
 * pre-flight compares with our balance (FR-C8). Same rule as the price the
 * customer sees (periodTotalKobo): the first term at the registration rate
 * for each of its years, later years at the renewal rate, plus the ICANN fee
 * per year on generic extensions. The first term is one year for most
 * extensions and two for .ai; the catalogue sync offers a period only where
 * the supplier's listed price for it is exactly this.
 */
export type SupplierCost = {
  registerUsd: number
  renewUsd: number
  isCountryCode: boolean
  /** The shortest registration the registry sells, in years. */
  firstTermYears: number
}

export function wholesaleCostUsd(
  lines: { tld: string; periodYears: number }[],
  costs: ReadonlyMap<string, SupplierCost>,
  icannFeeUsd: number,
): number {
  let cents = 0
  for (const line of lines) {
    const cost = costs.get(line.tld)
    if (!cost) throw new Error(`No supplier cost for .${line.tld}`)
    if (line.periodYears < cost.firstTermYears) {
      throw new Error(`.${line.tld} is not sold for ${line.periodYears} years`)
    }
    const perYearIcann = cost.isCountryCode ? 0 : icannFeeUsd
    cents += Math.round(
      (cost.registerUsd * cost.firstTermYears +
        cost.renewUsd * (line.periodYears - cost.firstTermYears) +
        perYearIcann * line.periodYears) *
        100,
    )
  }
  return cents / 100
}

/**
 * What an order's SSL certificates cost us, in USD (FR-SSL-6, FR-C8): the
 * supplier's price for each, from `ssl_products`. A product with no cost is
 * not sold — the order is refused rather than checked against a guess (N5b).
 */
export function sslCostUsd(
  lines: readonly { productCode: string }[],
  costs: ReadonlyMap<string, number | string | null>,
): number {
  let cents = 0
  for (const line of lines) {
    const cost = Number(costs.get(line.productCode) ?? Number.NaN)
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error(`No supplier cost for SSL product ${line.productCode}`)
    }
    cents += Math.round(cost * 100)
  }
  return cents / 100
}
