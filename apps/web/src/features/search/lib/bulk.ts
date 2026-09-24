import { AVAILABILITY_LIMITS } from '@dr/shared/availability'
import { type LengthIssue, type LengthRules, lengthIssue } from './length'
import { displayQuery, parseSearchQuery } from './query'

/**
 * Bulk search (PRD FR-S5): many names checked at once, each line answered on
 * its own.
 *
 * The supplier allows two calls in flight (PRD V4) and a call costs about the
 * same for one name as for twenty on the same extensions, so a bulk search is
 * packed into as few gateway requests as the contract allows — names grouped
 * by extension, never one request per line. Anything answerable here (not a
 * name, an extension we don't sell, a length the extension refuses — FR-S9)
 * never reaches the supplier.
 */

/** Names per bulk search. Within the gateway's per-request name limit, so one extension never needs two requests. */
export const BULK_MAX_NAMES = 20
/** Extensions a name without one can be checked on — the featured set at most. */
export const BULK_MAX_EXTENSIONS = 7

/** One name, one extension — the unit a result row shows. */
export type BulkCheck = {
  /** ASCII label. */
  name: string
  tld: string
  /** ASCII domain, what the supplier is asked about and a cart stores. */
  domain: string
  /** Set when the extension's length rule refuses the name: never asked about. */
  issue: LengthIssue | null
}

export type BulkLine =
  | { kind: 'invalid'; input: string }
  | { kind: 'mixed-script'; input: string; scripts: string[] }
  | { kind: 'unsold'; input: string; display: string; tld: string }
  | { kind: 'name'; input: string; display: string; checks: BulkCheck[] }

/** One gateway request: every name here is asked about on every extension here. */
export type BulkChunk = { names: string[]; tlds: string[] }

export type BulkPlan = {
  lines: BulkLine[]
  /** Names past BULK_MAX_NAMES, left unchecked. */
  skipped: number
  /** Where names without an extension were checked. */
  defaultTlds: string[]
  chunks: BulkChunk[]
}

/**
 * Pasted text → names. One per line is the contract; commas, semicolons and
 * spaces separate too, because that is how lists arrive from spreadsheets and
 * chats — and a domain name never contains any of them.
 */
export function splitNames(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean)
}

/**
 * The extensions for names typed without one: those picked that we sell, in
 * the order offered, or the lead extension when none was.
 */
export function pickDefaultTlds(
  picked: readonly string[],
  sold: ReadonlySet<string>,
  featured: readonly string[],
): string[] {
  const chosen = [...new Set(picked.map((tld) => tld.trim().toLowerCase()))]
    .filter((tld) => sold.has(tld))
    .slice(0, BULK_MAX_EXTENSIONS)
  if (chosen.length > 0) return chosen
  const lead = featured.find((tld) => sold.has(tld))
  return lead ? [lead] : []
}

export function planBulk({
  text,
  picked,
  sold,
  featured,
  lengthRules = {},
}: {
  text: string
  /** Extensions ticked for names without one. */
  picked: readonly string[]
  sold: ReadonlySet<string>
  featured: readonly string[]
  lengthRules?: LengthRules
}): BulkPlan {
  const defaultTlds = pickDefaultTlds(picked, sold, featured)
  const inputs = splitNames(text)
  const seen = new Set<string>()
  const lines: BulkLine[] = []
  let skipped = 0

  for (const input of inputs) {
    const parsed = parseSearchQuery(input)
    // A name typed twice is one line; `GetPaid.com` and `getpaid.com` are one name.
    const key = parsed.isValid ? displayQuery(parsed) : input
    if (seen.has(key)) continue
    seen.add(key)
    if (lines.length === BULK_MAX_NAMES) {
      skipped += 1
      continue
    }

    if (!parsed.isValid) {
      lines.push(
        parsed.problem
          ? { kind: 'mixed-script', input, scripts: parsed.problem.scripts }
          : { kind: 'invalid', input },
      )
      continue
    }
    if (parsed.tld && !sold.has(parsed.tld)) {
      lines.push({ kind: 'unsold', input, display: displayQuery(parsed), tld: parsed.tld })
      continue
    }

    const tlds = parsed.tld ? [parsed.tld] : defaultTlds
    lines.push({
      kind: 'name',
      input,
      display: displayQuery(parsed),
      checks: tlds.map((tld) => ({
        name: parsed.stem,
        tld,
        domain: `${parsed.stem}.${tld}`,
        issue: lengthIssue(parsed.stem, lengthRules[tld]),
      })),
    })
  }

  const asked = lines.flatMap((line) =>
    line.kind === 'name' ? line.checks.filter((check) => !check.issue) : [],
  )
  return { lines, skipped, defaultTlds, chunks: chunkChecks(asked) }
}

/**
 * Packs checks into gateway requests: each extension once, with only the
 * names wanted on it, up to the contract's limits per request. Extensions
 * asked about most go first, so the first answer fills the most lines.
 * The gateway splits each request into at most two supplier calls.
 */
export function chunkChecks(
  checks: readonly Pick<BulkCheck, 'name' | 'tld'>[],
  limits: { maxNames: number; maxTlds: number } = AVAILABILITY_LIMITS,
): BulkChunk[] {
  const namesByTld = new Map<string, Set<string>>()
  for (const { name, tld } of checks) {
    const names = namesByTld.get(tld) ?? new Set<string>()
    names.add(name)
    namesByTld.set(tld, names)
  }
  const tlds = [...namesByTld.keys()].sort(
    (a, b) => (namesByTld.get(b)?.size ?? 0) - (namesByTld.get(a)?.size ?? 0),
  )

  const chunks: BulkChunk[] = []
  let names = new Set<string>()
  let chunkTlds: string[] = []
  for (const tld of tlds) {
    const wanted = namesByTld.get(tld) ?? new Set<string>()
    const merged = new Set([...names, ...wanted])
    if (
      chunkTlds.length > 0 &&
      (chunkTlds.length >= limits.maxTlds || merged.size > limits.maxNames)
    ) {
      chunks.push({ names: [...names], tlds: chunkTlds })
      names = new Set(wanted)
      chunkTlds = [tld]
      continue
    }
    names = merged
    chunkTlds.push(tld)
  }
  if (chunkTlds.length > 0) chunks.push({ names: [...names], tlds: chunkTlds })
  return chunks
}

/** The request that answers a check. Every asked check is in exactly one. */
export function chunkFor(chunks: readonly BulkChunk[], check: Pick<BulkCheck, 'name' | 'tld'>) {
  return chunks.find((chunk) => chunk.tlds.includes(check.tld) && chunk.names.includes(check.name))
}

/** The canonical bulk URL: names one per line, readable forms, extensions repeated. */
export function bulkHref(names: readonly string[], tlds: readonly string[]): string {
  const params = new URLSearchParams()
  params.set(
    'names',
    names
      .map((name) => {
        const parsed = parseSearchQuery(name)
        return parsed.isValid ? displayQuery(parsed) : name
      })
      .join('\n'),
  )
  for (const tld of tlds) params.append('tld', tld)
  return `/search/bulk?${params.toString()}`
}
