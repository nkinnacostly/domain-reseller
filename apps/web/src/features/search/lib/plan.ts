/**
 * What a search asks the registrar about (PRD FR-S1, FR-S4, ADR-002).
 *
 * Every extension is one supplier call (~0.7s each, in parallel), and extra
 * names on an extension are nearly free — so the plan keeps the extension
 * count small and spends its breadth on names instead.
 */

/**
 * ADR-002 affix rules. Deterministic, no model in the request path. Order is
 * display order, most natural-sounding first.
 */
export const AFFIXES = {
  prefixes: ['get', 'try', 'use', 'go', 'my', 'the'],
  suffixes: ['hq', 'app', 'hub', 'now', 'ly', 'online'],
} as const

const MAX_LABEL = 63

/** How many extensions the exact-match grid checks, the typed one included. */
export const GRID_SIZE = 7
/** How many extensions suggestions are checked on. */
export const SUGGESTION_TLDS = 2

export function suggestionNames(stem: string): string[] {
  const candidates = [
    ...AFFIXES.prefixes.map((prefix) => `${prefix}${stem}`),
    ...AFFIXES.suffixes.map((suffix) => `${stem}${suffix}`),
  ]
  return [
    ...new Set(
      candidates.filter(
        (name) =>
          name !== stem &&
          name.length <= MAX_LABEL &&
          // The stem already carries the affix: `getpaid` → `getgetpaid` reads as a typo.
          !AFFIXES.prefixes.some((p) => name.startsWith(`${p}${p}`)) &&
          !AFFIXES.suffixes.some((s) => name.endsWith(`${s}${s}`)),
      ),
    ),
  ]
}

export type SearchPlan = {
  stem: string
  /** The one domain the page leads with. Null when the typed extension is not one we sell. */
  exact: { name: string; tld: string } | null
  /** An extension the person typed that we do not sell. */
  unsoldTld: string | null
  /** Extensions checked for the stem, exact first. */
  gridTlds: string[]
  suggestionTlds: string[]
  suggestionNames: string[]
}

export function planSearch({
  stem,
  tld,
  sold,
  featured,
}: {
  stem: string
  tld: string | null
  /** Every extension we sell right now. */
  sold: ReadonlySet<string>
  /** Merchandised extensions in rank order (tlds.featured_rank). */
  featured: readonly string[]
}): SearchPlan {
  const typedIsSold = tld !== null && sold.has(tld)
  const lead = typedIsSold ? tld : (featured[0] ?? null)

  const gridTlds = [...new Set([...(typedIsSold ? [tld] : []), ...featured])]
    .filter((candidate) => sold.has(candidate))
    .slice(0, GRID_SIZE)

  // Suggestions follow the extension the person chose, then the lead one.
  const suggestionTlds = [...new Set([lead, ...featured].filter((t): t is string => t !== null))]
    .filter((candidate) => sold.has(candidate))
    .slice(0, SUGGESTION_TLDS)

  return {
    stem,
    exact: tld !== null && !typedIsSold ? null : lead ? { name: stem, tld: lead } : null,
    unsoldTld: tld !== null && !typedIsSold ? tld : null,
    gridTlds,
    suggestionTlds,
    suggestionNames: suggestionNames(stem),
  }
}
