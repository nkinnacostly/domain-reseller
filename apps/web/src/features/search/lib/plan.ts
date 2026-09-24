import { mixedScripts, toAsciiHost, toUnicodeLabel } from './idn'
import { type LengthIssue, type LengthRules, lengthIssue } from './length'

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
  // An international name takes its affixes as people read it — `getcafé`,
  // not `getxn--caf-dma` — and goes back to ASCII for the supplier (FR-S8).
  const readable = toUnicodeLabel(stem) ?? stem
  const candidates = [
    ...AFFIXES.prefixes.map((prefix) => `${prefix}${readable}`),
    ...AFFIXES.suffixes.map((suffix) => `${readable}${suffix}`),
  ]
  return [
    ...new Set(
      candidates
        .filter(
          (name) =>
            // The stem already carries the affix: `getpaid` → `getgetpaid` reads as a typo.
            !AFFIXES.prefixes.some((p) => name.startsWith(`${p}${p}`)) &&
            !AFFIXES.suffixes.some((s) => name.endsWith(`${s}${s}`)) &&
            // Latin affixes on a Cyrillic or Greek name make a lookalike (FR-S8).
            !mixedScripts(name),
        )
        .map((name) => toAsciiHost(name) ?? '')
        .filter((name) => name !== '' && name !== stem && name.length <= MAX_LABEL),
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
  /** FR-S9 — length rules for the extensions this plan touches. */
  lengthRules: LengthRules
}

/** Why an extension refuses the searched name outright (FR-S9), or null. */
export function stemIssue(plan: SearchPlan, tld: string): LengthIssue | null {
  return lengthIssue(plan.stem, plan.lengthRules[tld])
}

/** Suggestion names an extension can accept (FR-S9) — the rest are never asked about. */
export function suggestionNamesFor(plan: SearchPlan, tld: string): string[] {
  return plan.suggestionNames.filter((name) => !lengthIssue(name, plan.lengthRules[tld]))
}

export function planSearch({
  stem,
  tld,
  sold,
  featured,
  lengthRules = {},
}: {
  stem: string
  tld: string | null
  /** Every extension we sell right now. */
  sold: ReadonlySet<string>
  /** Merchandised extensions in rank order (tlds.featured_rank). */
  featured: readonly string[]
  /** Per-extension length rules, where the catalogue knows them (FR-S9). */
  lengthRules?: LengthRules
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
    lengthRules: Object.fromEntries(
      Object.entries(lengthRules).filter(
        ([candidate]) => gridTlds.includes(candidate) || suggestionTlds.includes(candidate),
      ),
    ),
  }
}
