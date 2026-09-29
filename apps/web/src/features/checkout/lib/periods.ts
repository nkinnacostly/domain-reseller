/**
 * An order line's `renewal_years` (migration 37): the term its one-year
 * `renewal_kobo` renews in, so the order page, receipt and email say "every
 * 2 years" where that is the only renewal sold (N8). A year is the column's
 * default and is left out, so a line of a one-year extension is written
 * exactly as before — and a database the migration has not reached yet still
 * takes it.
 */
export function renewalTermColumn(years: number): { renewal_years?: number } {
  return years === 1 ? {} : { renewal_years: years }
}

/**
 * Lines whose period the registry does not sell (FR-C2, N9b). The cart moves
 * such a line to a period it does sell and asks for the new price to be
 * accepted first (priceLine), so none should reach payment; this is the
 * check that none does. A line we no longer sell at all is the cart's
 * `unavailable`, refused separately.
 */
export function unsoldPeriods<
  T extends {
    domain: string
    periodYears: number
    registerPeriods: readonly number[]
    unsoldYears: number | null
    status: string
  },
>(lines: readonly T[]): T[] {
  return lines.filter(
    (line) =>
      line.status !== 'unavailable' &&
      (line.unsoldYears !== null || !line.registerPeriods.includes(line.periodYears)),
  )
}
