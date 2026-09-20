import { KOBO_PER_NAIRA } from './index'
import { type CatalogueEntry, type FxSettings, quote } from './policy'

/**
 * Comparing a freshly fetched catalogue against the committed snapshot.
 *
 * Supplier prices move — Verisign raises `.com` on 1 November 2026, and the
 * increase flows through to our tier. A sync that silently overwrote the
 * snapshot would let us keep selling at a margin that no longer exists, so
 * the diff is the point of the exercise, not a nicety.
 */
export type PriceField = 'register' | 'renew' | 'transfer'

export type FieldChange = {
  field: PriceField
  before: number | undefined
  after: number | undefined
}

export type ChangedTld = {
  name: string
  changes: FieldChange[]
}

export type CatalogueDiff = {
  added: CatalogueEntry[]
  removed: CatalogueEntry[]
  changed: ChangedTld[]
  unchanged: number
}

const FIELDS: PriceField[] = ['register', 'renew', 'transfer']

export function diffCatalogue(before: CatalogueEntry[], after: CatalogueEntry[]): CatalogueDiff {
  const beforeByName = new Map(before.map((e) => [e.name, e]))
  const afterByName = new Map(after.map((e) => [e.name, e]))

  const added = after.filter((e) => !beforeByName.has(e.name))
  const removed = before.filter((e) => !afterByName.has(e.name))

  const changed: ChangedTld[] = []
  let unchanged = 0

  for (const entry of after) {
    const previous = beforeByName.get(entry.name)
    if (!previous) continue

    const changes = FIELDS.map((field) => ({
      field,
      before: previous[field],
      after: entry[field],
    })).filter((c) => c.before !== c.after)

    if (changes.length > 0) changed.push({ name: entry.name, changes })
    else unchanged++
  }

  return { added, removed, changed, unchanged }
}

export type RetailImpact = {
  name: string
  kind: 'registration' | 'renewal'
  /** Retail price we are showing today, from the committed snapshot. */
  currentRetailNgn: number
  /** Retail price once the new cost applies. */
  newRetailNgn: number
  deltaNgn: number
  deltaPct: number
  /**
   * The dangerous case. Until the snapshot is regenerated and deployed the
   * site keeps quoting the OLD price against the NEW cost — if that price no
   * longer covers cost, every sale loses money.
   */
  sellingBelowCost: boolean
}

/**
 * What a catalogue change does to the prices customers see.
 *
 * A margin-below-floor check would be pointless: margin is `max(raw, floor)`
 * and rounding only ever goes up, so price − cost is never below the floor by
 * construction. The real exposure is the window between the supplier changing
 * a price and us redeploying — during it we quote yesterday's price against
 * today's cost.
 */
export function retailImpact(
  before: CatalogueEntry[],
  after: CatalogueEntry[],
  fx: FxSettings,
): RetailImpact[] {
  const beforeByName = new Map(before.map((e) => [e.name, e]))
  const impacts: RetailImpact[] = []

  for (const entry of after) {
    const previous = beforeByName.get(entry.name)
    if (!previous) continue

    for (const kind of ['registration', 'renewal'] as const) {
      const was = quote(previous, kind, fx)
      const now = quote(entry, kind, fx)
      if (!was || !now) continue
      if (was.priceKobo === now.priceKobo && was.costKobo === now.costKobo) continue

      const currentRetailNgn = was.priceKobo / KOBO_PER_NAIRA
      const newRetailNgn = now.priceKobo / KOBO_PER_NAIRA
      const newCostNgn = now.costKobo / KOBO_PER_NAIRA

      impacts.push({
        name: entry.name,
        kind,
        currentRetailNgn,
        newRetailNgn,
        deltaNgn: newRetailNgn - currentRetailNgn,
        deltaPct: ((newRetailNgn - currentRetailNgn) / currentRetailNgn) * 100,
        sellingBelowCost: currentRetailNgn < newCostNgn,
      })
    }
  }

  // Loss-making first, then the largest increases.
  return impacts.sort(
    (a, b) => Number(b.sellingBelowCost) - Number(a.sellingBelowCost) || b.deltaPct - a.deltaPct,
  )
}

export function hasChanges(diff: CatalogueDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
}
