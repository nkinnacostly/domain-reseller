import { AVAILABILITY_LIMITS } from '@dr/shared/availability'
import { type LengthIssue, type LengthRules, lengthIssue } from './length'
import { displayQuery, parseSearchQuery } from './query'

/**
 * Bulk search (PRD FR-S5): up to 500 names, pasted or read from a CSV file,
 * each line answered on its own.
 *
 * The supplier allows two calls in flight for the whole account (PRD V4) and
 * refuses a call of more than 20 name × extension checks (measured 24 Sept
 * 2026), and a call costs per extension, not per name: 20 names on one
 * extension answered in about 2 s, 5 names on four in about 6 s. So a list is
 * packed into blocks of up to 20 names on one extension — each block one
 * gateway request and one supplier call — and the blocks go one after another
 * at low priority. Anything answerable here (not a name, an
 * extension we don't sell, a length the extension refuses — FR-S9) never
 * reaches the supplier.
 */

/** Names per bulk search. */
export const BULK_MAX_NAMES = 500
/** Extensions a name without one can be checked on — the featured set at most. */
export const BULK_MAX_EXTENSIONS = 7
/** One gateway request of a bulk search: one supplier call, within its ceiling. */
export const BULK_CHUNK = {
  maxNames: AVAILABILITY_LIMITS.maxChecksPerCall,
  maxTlds: 1,
} as const

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
  /** Every check the supplier is asked about — those no rule refused here. */
  asked: BulkCheck[]
  chunks: BulkChunk[]
  /** Kept so a retry packs its requests by the same rules (FR-S9). */
  lengthRules: LengthRules
}

/**
 * Pasted text → names. One per line is the contract; commas, semicolons and
 * spaces separate too, because that is how lists arrive from spreadsheets and
 * chats — and a domain name never contains any of them.
 */
export function splitNames(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean)
}

/** How many different names a list holds, as bulk search counts them. */
export function countNames(text: string): number {
  return new Set(splitNames(text).map((name) => name.toLowerCase())).size
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

  const asked = uniqueChecks(
    lines.flatMap((line) =>
      line.kind === 'name' ? line.checks.filter((check) => !check.issue) : [],
    ),
  )
  return { lines, skipped, defaultTlds, asked, chunks: packChecks(asked, lengthRules), lengthRules }
}

/** Requests for these checks, never pairing a name with an extension that refuses it (FR-S9). */
export function packChecks(checks: readonly BulkCheck[], lengthRules: LengthRules): BulkChunk[] {
  return chunkChecks(checks, { canAsk: (name, tld) => !lengthIssue(name, lengthRules[tld]) })
}

/** `getpaid` and `getpaid.com` on .com are one question. */
function uniqueChecks(checks: readonly BulkCheck[]): BulkCheck[] {
  const byDomain = new Map<string, BulkCheck>()
  for (const check of checks) if (!byDomain.has(check.domain)) byDomain.set(check.domain, check)
  return [...byDomain.values()]
}

/**
 * Packs checks into gateway requests.
 *
 * Names wanted on the same extensions are blocked together, in the order
 * they were typed, so the rows fill from the top. Blocks that are not full
 * then share a request where the limits allow — fewer requests for the same
 * supplier work, since a call costs per extension, not per name — unless
 * sharing would ask about a name an extension refuses (FR-S9).
 */
export function chunkChecks(
  checks: readonly Pick<BulkCheck, 'name' | 'tld'>[],
  {
    limits = BULK_CHUNK,
    canAsk = () => true,
  }: {
    limits?: { maxNames: number; maxTlds: number }
    canAsk?: (name: string, tld: string) => boolean
  } = {},
): BulkChunk[] {
  const tldsByName = new Map<string, string[]>()
  for (const { name, tld } of checks) {
    const tlds = tldsByName.get(name) ?? []
    if (!tlds.includes(tld)) tlds.push(tld)
    tldsByName.set(name, tlds)
  }

  const groups = new Map<string, BulkChunk>()
  for (const [name, tlds] of tldsByName) {
    const key = [...tlds].sort().join(' ')
    const group = groups.get(key) ?? { names: [], tlds }
    group.names.push(name)
    groups.set(key, group)
  }

  // Names outer, extensions inner, so each name's rows fill before the next's.
  const blocks: BulkChunk[] = []
  for (const group of groups.values()) {
    const perBlock = Math.max(
      1,
      Math.min(
        limits.maxNames,
        Math.floor(
          AVAILABILITY_LIMITS.maxChecksPerCall / Math.min(limits.maxTlds, group.tlds.length),
        ),
      ),
    )
    for (let n = 0; n < group.names.length; n += perBlock) {
      for (let t = 0; t < group.tlds.length; t += limits.maxTlds) {
        blocks.push({
          names: group.names.slice(n, n + perBlock),
          tlds: group.tlds.slice(t, t + limits.maxTlds),
        })
      }
    }
  }

  const chunks: BulkChunk[] = []
  for (const block of blocks) {
    const home = chunks.find((chunk) => canShare(chunk, block, limits, canAsk))
    if (!home) {
      chunks.push({ names: [...block.names], tlds: [...block.tlds] })
      continue
    }
    for (const name of block.names) if (!home.names.includes(name)) home.names.push(name)
    for (const tld of block.tlds) if (!home.tlds.includes(tld)) home.tlds.push(tld)
  }
  return chunks
}

function canShare(
  chunk: BulkChunk,
  block: BulkChunk,
  limits: { maxNames: number; maxTlds: number },
  canAsk: (name: string, tld: string) => boolean,
): boolean {
  const names = new Set([...chunk.names, ...block.names])
  const tlds = new Set([...chunk.tlds, ...block.tlds])
  if (names.size > limits.maxNames || tlds.size > limits.maxTlds) return false
  // The supplier refuses a call of more checks than this (HTTP 403).
  if (names.size * tlds.size > AVAILABILITY_LIMITS.maxChecksPerCall) return false
  for (const name of names) for (const tld of tlds) if (!canAsk(name, tld)) return false
  return true
}

/** The checks a request answers: those wanted, on the names and extensions it asks about. */
export function checksIn<T extends Pick<BulkCheck, 'name' | 'tld'>>(
  chunk: BulkChunk,
  checks: readonly T[],
): T[] {
  const names = new Set(chunk.names)
  const tlds = new Set(chunk.tlds)
  return checks.filter((check) => names.has(check.name) && tlds.has(check.tld))
}
