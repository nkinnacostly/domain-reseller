/**
 * What an order costs us at the supplier, in USD — the figure the float
 * pre-flight compares with our balance (FR-C8). Same rule as the price the
 * customer sees: first year at registration, later years at renewal, plus the
 * ICANN fee per year on generic extensions.
 */
export type SupplierCost = { registerUsd: number; renewUsd: number; isCountryCode: boolean }

export function wholesaleCostUsd(
  lines: { tld: string; periodYears: number }[],
  costs: ReadonlyMap<string, SupplierCost>,
  icannFeeUsd: number,
): number {
  let cents = 0
  for (const line of lines) {
    const cost = costs.get(line.tld)
    if (!cost) throw new Error(`No supplier cost for .${line.tld}`)
    const perYearIcann = cost.isCountryCode ? 0 : icannFeeUsd
    cents += Math.round(
      (cost.registerUsd +
        cost.renewUsd * (line.periodYears - 1) +
        perYearIcann * line.periodYears) *
        100,
    )
  }
  return cents / 100
}
