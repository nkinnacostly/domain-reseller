import type { AvailabilityStatus } from '@dr/shared/availability'
import { type BulkChunk, type BulkPlan, checksIn, packChecks } from './bulk'
import { toUnicodeHost } from './idn'
import { refusalNote } from './rows'

/**
 * A bulk search in progress (FR-S5): which checks are answered, which are
 * still waiting, and which could not be checked and why. Pure — the page
 * drives it one gateway request at a time, and every screen state is derived
 * from it, so it is tested without a browser.
 */

/** A price as bulk results show and export it. Retail figures only — never cost. */
export type BulkPrice = {
  register: string
  renew: string
  renewalIsHigher: boolean
  /** gTLDs carry the ICANN fee, and it is already in the price (FR-S2). */
  includesIcannFee: boolean
  maxPeriod: number
  /** For sorting and for the CSV: the same figures, in kobo (N5). */
  registerKobo: number
  renewKobo: number
}

/**
 * Why names were not checked:
 * - `unavailable` — the registry did not answer for them this time
 * - `busy` — too many bulk searches at once, across everyone
 * - `limited` — this connection has checked a lot of names lately
 * - `unconfirmed` — no search pass (SEC-9). The page pauses for the Turnstile
 *   check first; this is recorded only when the server still refuses right
 *   after a pass — the browser did not keep the cookie (BulkRunProvider)
 * - `stopped` — the person stopped the search
 */
export type FailReason = 'unavailable' | 'busy' | 'limited' | 'unconfirmed' | 'stopped'

/** What the server answers for one request (see actions/bulk.ts). */
export type BulkAnswer =
  | {
      ok: true
      results: { domain: string; status: AvailabilityStatus }[]
      /** Per extension asked about. */
      prices: Record<string, BulkPrice>
    }
  | { ok: false; reason: FailReason }

export type CheckState =
  | { state: 'pending' }
  | { state: 'done'; status: Exclude<AvailabilityStatus, 'unknown'>; price: BulkPrice | null }
  | { state: 'failed'; reason: FailReason }

export type BulkRun = {
  /** Distinguishes one run from the next, so a late answer never lands in a newer list. */
  id: number
  plan: BulkPlan
  /** Every asked check, by ASCII domain. */
  checks: ReadonlyMap<string, CheckState>
  running: boolean
}

export type BulkAction =
  | { type: 'start'; id: number; plan: BulkPlan }
  | { type: 'answer'; id: number; chunk: BulkChunk; answer: BulkAnswer }
  /** Checks in these requests will not be asked about this time. */
  | { type: 'halt'; id: number; chunks: BulkChunk[]; reason: FailReason }
  | { type: 'retry'; id: number }
  | { type: 'finish'; id: number }

export function startRun(id: number, plan: BulkPlan): BulkRun {
  return {
    id,
    plan,
    checks: new Map(plan.asked.map((check) => [check.domain, { state: 'pending' }])),
    running: plan.chunks.length > 0,
  }
}

export function reduceRun(run: BulkRun | null, action: BulkAction): BulkRun | null {
  if (action.type === 'start') return startRun(action.id, action.plan)
  if (!run || run.id !== action.id) return run

  switch (action.type) {
    case 'answer': {
      const checks = new Map(run.checks)
      const { answer } = action
      const statusOf = new Map(answer.ok ? answer.results.map((r) => [r.domain, r.status]) : [])
      for (const check of checksIn(action.chunk, run.plan.asked)) {
        if (checks.get(check.domain)?.state !== 'pending') continue
        checks.set(check.domain, settle(answer, statusOf.get(check.domain), check.tld))
      }
      return { ...run, checks }
    }
    case 'halt': {
      const checks = new Map(run.checks)
      for (const chunk of action.chunks) {
        for (const check of checksIn(chunk, run.plan.asked)) {
          if (checks.get(check.domain)?.state === 'pending') {
            checks.set(check.domain, { state: 'failed', reason: action.reason })
          }
        }
      }
      return { ...run, checks }
    }
    case 'retry': {
      const checks = new Map(run.checks)
      for (const [domain, state] of checks) {
        if (state.state === 'failed') checks.set(domain, { state: 'pending' })
      }
      return { ...run, checks, running: true }
    }
    case 'finish':
      return { ...run, running: false }
  }
}

function settle(
  answer: BulkAnswer,
  status: AvailabilityStatus | undefined,
  tld: string,
): CheckState {
  if (!answer.ok) return { state: 'failed', reason: answer.reason }
  // `unknown` is the registry not answering for this one: not checked, and retryable.
  if (!status || status === 'unknown') return { state: 'failed', reason: 'unavailable' }
  return {
    state: 'done',
    status,
    price: status === 'available' ? (answer.prices[tld] ?? null) : null,
  }
}

/** Requests for the checks that could not be checked, packed afresh. */
export function retryChunks(run: BulkRun): BulkChunk[] {
  const failed = run.plan.asked.filter((check) => run.checks.get(check.domain)?.state === 'failed')
  return packChecks(failed, run.plan.lengthRules)
}

/** Names not checked, in the order typed, readable. */
export function uncheckedDomains(run: BulkRun): string[] {
  return run.plan.asked
    .filter((check) => run.checks.get(check.domain)?.state === 'failed')
    .map((check) => toUnicodeHost(check.domain))
}

/** The reason to lead with when some names were not checked — the one that needs the person. */
export function failureReason(run: BulkRun): FailReason | null {
  const reasons = new Set<FailReason>()
  for (const state of run.checks.values()) if (state.state === 'failed') reasons.add(state.reason)
  for (const reason of ['limited', 'unconfirmed', 'busy', 'unavailable', 'stopped'] as const) {
    if (reasons.has(reason)) return reason
  }
  return null
}

/**
 * "312 of 500 checked" — in names, as they were typed. A name is checked once
 * every extension it was asked about has answered; a line refused here is
 * checked from the start. `settled` also counts names that could not be
 * checked, so progress reaches the end even when some could not.
 */
export function progress(run: BulkRun): { total: number; checked: number; settled: number } {
  let checked = 0
  let settled = 0
  for (const line of run.plan.lines) {
    const states =
      line.kind === 'name'
        ? line.checks.filter((check) => !check.issue).map((check) => run.checks.get(check.domain))
        : []
    if (states.every((state) => state?.state === 'done')) checked += 1
    if (states.every((state) => state?.state !== 'pending')) settled += 1
  }
  return { total: run.plan.lines.length, checked, settled }
}

// ── Result rows ─────────────────────────────────────────────────────────────

export type RowCategory = 'pending' | 'available' | 'taken' | 'premium' | 'refused' | 'unchecked'

/** One row of the results: one name on one extension, or a line refused as typed. */
export type ResultRow = {
  key: string
  /** Position in the list as typed, for "as listed" order. */
  order: number
  /** What people read — `café.com`, or the line as typed when it is not a name. */
  display: string
  /** The ASCII domain; null for a line that is not one. */
  domain: string | null
  /** ASCII label, for the lookalike warning (FR-S8). */
  name: string | null
  tld: string | null
  category: RowCategory
  status: AvailabilityStatus | null
  /** The badge for a line refused as typed. */
  label: string | null
  /** Why it cannot be bought, where there is something specific to say. */
  note: string | null
  price: BulkPrice | null
}

const CATEGORY: Record<Exclude<AvailabilityStatus, 'unknown'>, RowCategory> = {
  available: 'available',
  registered: 'taken',
  premium: 'premium',
  restricted: 'refused',
}

export function resultRows(run: BulkRun): ResultRow[] {
  const rows: ResultRow[] = []
  for (const line of run.plan.lines) {
    if (line.kind !== 'name') {
      rows.push(refusedLine(line, rows.length))
      continue
    }
    for (const check of line.checks) {
      const base = {
        key: check.domain,
        order: rows.length,
        display: toUnicodeHost(check.domain),
        domain: check.domain,
        name: check.name,
        tld: check.tld,
        label: null,
        price: null,
      }
      if (check.issue) {
        rows.push({
          ...base,
          category: 'refused',
          status: 'restricted',
          note: refusalNote({ ...base, status: 'restricted', lengthIssue: check.issue }),
        })
        continue
      }
      const state = run.checks.get(check.domain) ?? { state: 'pending' }
      if (state.state === 'pending') {
        rows.push({ ...base, category: 'pending', status: null, note: null })
      } else if (state.state === 'failed') {
        rows.push({ ...base, category: 'unchecked', status: 'unknown', note: null })
      } else {
        rows.push({
          ...base,
          category: CATEGORY[state.status],
          status: state.status,
          note: refusalNote({ ...base, status: state.status }),
          price: state.price,
        })
      }
    }
  }
  return rows
}

function refusedLine(
  line: Exclude<BulkPlan['lines'][number], { kind: 'name' }>,
  order: number,
): ResultRow {
  const base = {
    key: `line-${order}`,
    order,
    domain: null,
    name: null,
    tld: null,
    category: 'refused' as const,
    status: null,
    price: null,
  }
  switch (line.kind) {
    case 'invalid':
      return {
        ...base,
        display: line.input,
        label: 'Not a domain',
        note: 'Use letters, numbers and hyphens — for example getpaid or getpaid.com',
      }
    case 'mixed-script':
      return {
        ...base,
        display: line.input,
        label: 'Not sold',
        // FR-S8 — refused, with the reason in plain words.
        note: `Mixes ${line.scripts.join(' and ')} letters, the way lookalike names are made`,
      }
    case 'unsold':
      return {
        ...base,
        display: line.display,
        label: 'Not sold',
        note: `We don't sell .${toUnicodeHost(line.tld)}`,
      }
  }
}

export type BulkTally = Record<RowCategory, number>

export function tally(rows: readonly ResultRow[]): BulkTally {
  const counts: BulkTally = {
    pending: 0,
    available: 0,
    taken: 0,
    premium: 0,
    refused: 0,
    unchecked: 0,
  }
  for (const row of rows) counts[row.category] += 1
  return counts
}

/** Rows that can go in a cart: available, and priced (N5b — no price, no sale). */
export function isSelectable(row: ResultRow): row is ResultRow & { domain: string } {
  return row.category === 'available' && row.price !== null && row.domain !== null
}

export const FILTERS = ['all', 'available', 'taken', 'premium', 'unchecked'] as const
export type RowFilter = (typeof FILTERS)[number]

export function filterRows(rows: readonly ResultRow[], filter: RowFilter): ResultRow[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => row.category === filter)
}

export const SORTS = ['list', 'name', 'price'] as const
export type RowSort = (typeof SORTS)[number]

/**
 * As listed; by name as people read it; or cheapest first — rows without a
 * price (taken, premium, not checked) after every priced one, as listed.
 */
export function sortRows(rows: readonly ResultRow[], sort: RowSort): ResultRow[] {
  const byOrder = (a: ResultRow, b: ResultRow) => a.order - b.order
  if (sort === 'name') {
    return [...rows].sort((a, b) => a.display.localeCompare(b.display) || byOrder(a, b))
  }
  if (sort === 'price') {
    const rank = (row: ResultRow) => row.price?.registerKobo ?? Number.POSITIVE_INFINITY
    return [...rows].sort((a, b) => rank(a) - rank(b) || byOrder(a, b))
  }
  return [...rows].sort(byOrder)
}
