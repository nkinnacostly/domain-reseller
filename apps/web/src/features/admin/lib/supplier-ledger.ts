import { type LedgerMatchState, ledgerKind, normaliseTraceId } from '@dr/shared/admin'
import { formatUsd } from './format'
import { type ListParams, type ListSpec, listHref, parseListParams } from './list-params'

/**
 * The supplier ledger mirror as the Ledger page reads it (docs/ADMIN-SPEC.md
 * §5.2 B6, §7): its URL (`?status=&from=&to=&trace=&sort=&dir=&page=&per=`),
 * what each entry's match means in words, its kind, the balance chain and a
 * revision's changes. The overview links here with `?status=unexplained`
 * (§9, the cross-page link contract); an alert with `?trace=<id>` (§4.5).
 */

export const LEDGER_STATES = [
  'unexplained',
  'unclassified',
  'pending',
  'matched',
  'topup',
] as const satisfies readonly LedgerMatchState[]

export const LEDGER_SORTS = ['occurred', 'change'] as const
export type LedgerSort = (typeof LEDGER_SORTS)[number]

export const LEDGER_LIST: ListSpec<LedgerSort, LedgerMatchState> = {
  sorts: LEDGER_SORTS,
  defaultSort: 'occurred',
  statuses: LEDGER_STATES,
  perOptions: [25, 50, 100],
}

export const LEDGER_BASE = '/admin/supplier/ledger'

/** The column each sort orders by. */
export const LEDGER_SORT_COLUMN: Record<LedgerSort, 'occurred_at' | 'delta_cents'> = {
  occurred: 'occurred_at',
  change: 'delta_cents',
}

export type LedgerSearch = ListParams<LedgerSort, LedgerMatchState> & {
  /** One entry, from an alert's link: a GUID, lower-cased (§7). */
  trace: string | null
}

type Search = Record<string, string | string[] | undefined>

export function parseLedgerSearch(search: Search): LedgerSearch {
  const params = parseListParams(search, LEDGER_LIST)
  const raw = search.trace
  const trace = normaliseTraceId(Array.isArray(raw) ? raw[0] : raw)
  return { ...params, trace }
}

/** A link to the ledger with some values changed; the trace is kept unless cleared. */
export function ledgerHref(
  params: LedgerSearch,
  changes: Partial<ListParams<LedgerSort, LedgerMatchState>> & { trace?: string | null } = {},
): string {
  const { trace, ...rest } = changes
  const kept = trace === undefined ? params.trace : trace
  return listHref(LEDGER_BASE, params, LEDGER_LIST, {
    ...rest,
    ...(trace !== undefined ? { page: 1 } : {}),
    extra: { trace: kept },
  })
}

/** Whether anything narrows the list: the empty state then offers to clear it. */
export function isFiltered(params: LedgerSearch): boolean {
  return params.status.length > 0 || Boolean(params.from || params.to || params.trace)
}

/**
 * A Lagos calendar day's bounds as instants (WAT is UTC+1, with no daylight
 * saving): from the first day's midnight to the midnight after the last.
 */
export function lagosRange(
  from: string | null,
  to: string | null,
): { gte: string | null; lt: string | null } {
  const start = (day: string) => new Date(`${day}T00:00:00+01:00`)
  const gte = from ? start(from).toISOString() : null
  let lt: string | null = null
  if (to) {
    const next = start(to)
    next.setUTCDate(next.getUTCDate() + 1)
    lt = next.toISOString()
  }
  return { gte, lt }
}

/** What a match operation bought, in words. */
const OPERATION_WORDS: Readonly<Record<string, string>> = {
  RegisterWithContactInfo: 'a registration',
  Renew: 'a renewal',
  Transfer: 'a transfer in',
  SslInitialize: 'a certificate order',
  SslReissue: 'a certificate reissue',
}

export type LedgerMatchFacts = {
  matchState: string
  matchOperation: string | null
  status: number
}

/**
 * What an entry's match means, in a sentence (§7): matched to the call that
 * spent it, a top-up, not yet matched, or the two kinds that need a person.
 */
export function matchLabel(entry: LedgerMatchFacts): string {
  switch (entry.matchState) {
    case 'matched': {
      const words = entry.matchOperation ? OPERATION_WORDS[entry.matchOperation] : null
      if (words) return `Matched to ${words}`
      return entry.matchOperation ? `Matched to ${entry.matchOperation}` : 'Matched to an order'
    }
    case 'topup':
      return 'A top-up of our float'
    case 'pending':
      return 'Waiting to match: a debit is matched to its provisioning call within 2 hours'
    case 'unexplained':
      return 'No matching provisioning call: supplier panel use, a leaked key, or a supplier-side change'
    case 'unclassified':
      return entry.status !== 1
        ? `Not settled at DomainNameAPI (status ${entry.status}): shown as read, never counted`
        : 'Not a shape we classify: shown as read, never counted'
    default:
      return entry.matchState.replace(/_/g, ' ')
  }
}

const KIND_WORDS = {
  topup: 'Top-up',
  domain_charge: 'Domain charge',
  ssl_charge: 'Certificate charge',
} as const

export type LedgerFactsRow = {
  type: number
  status: number
  chargeType: number
  productType: number
}

/**
 * The entry's kind from the supplier's integers (§4.3 `LedgerKind`). Anything
 * unclassified shows its integers raw: the supplier publishes no meaning for
 * them, and a guess would be a claim we cannot back (N9b).
 */
export function kindLabel(facts: LedgerFactsRow): string {
  const kind = ledgerKind(facts)
  if (kind !== 'unclassified') return KIND_WORDS[kind]
  return `Unclassified (type ${facts.type}, charge ${facts.chargeType}, product ${facts.productType}, status ${facts.status})`
}

/** "+$36.00" for a credit, "−$11.31" for a debit. */
export function formatDelta(cents: number): string {
  return cents > 0 ? `+${formatUsd(cents)}` : formatUsd(cents)
}

export type ChainEntry = {
  traceId: string
  occurredAt: string
  description: string
  oldBalanceCents: number
  balanceCents: number
}

export type ChainBreak = {
  traceId: string
  occurredAt: string
  /** The balance the previous entry ended on. */
  expectedCents: number
  /** The balance this entry says it started from. */
  foundCents: number
}

export type ChainCheck = {
  count: number
  breaks: ChainBreak[]
  /** The balances along the chain, oldest first: the first entry's start, then each end. */
  strip: number[]
  lastCents: number | null
}

/** How many balances the strip shows: the latest few, enough to read the chain's shape. */
export const STRIP_LENGTH = 6

/**
 * The balance chain (§7.5, `ledger_gap`): each entry must start where the one
 * before it ended, ordered by time and trace id. On the test side, e2e's own
 * `e2e-` rows are left out, as SQL leaves them out of every check there.
 */
export function checkChain(entries: readonly ChainEntry[], side: 'live' | 'test'): ChainCheck {
  const kept = entries
    .filter((entry) => side === 'live' || !entry.description.startsWith('e2e-'))
    .slice()
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? a.traceId.localeCompare(b.traceId)
        : Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    )
  const breaks: ChainBreak[] = []
  const balances: number[] = []
  kept.forEach((entry, index) => {
    const previous = kept[index - 1]
    if (index === 0) balances.push(entry.oldBalanceCents)
    if (previous && previous.balanceCents !== entry.oldBalanceCents) {
      breaks.push({
        traceId: entry.traceId,
        occurredAt: entry.occurredAt,
        expectedCents: previous.balanceCents,
        foundCents: entry.oldBalanceCents,
      })
      balances.push(entry.oldBalanceCents)
    }
    balances.push(entry.balanceCents)
  })
  return {
    count: kept.length,
    breaks,
    strip: balances.slice(-STRIP_LENGTH),
    lastCents: kept.at(-1)?.balanceCents ?? null,
  }
}

/** "0.00 → 15.00 → 3.69": the strip in dollars, as the spec's chain is written. */
export function stripWords(strip: readonly number[]): string {
  return strip.map((cents) => formatUsd(cents).replace(/^\$/, '').replace(/^−\$/, '−')).join(' → ')
}

type RevisionValue = string | number | boolean | null

/**
 * A revision's changes as lines (§3.2a): `{field: {stored, read}}`, each
 * "status: 0 → 1". Anything not in that shape is shown as "changed", never
 * dropped: a supplier rewriting its past is the point of keeping these.
 */
export function revisionLines(changes: unknown): string[] {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return []
  return Object.entries(changes as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, change]) => {
      const name = field.replace(/_/g, ' ')
      if (typeof change === 'object' && change !== null && 'stored' in change && 'read' in change) {
        const { stored, read } = change as { stored: unknown; read: unknown }
        return `${name}: ${show(stored)} → ${show(read)}`
      }
      return `${name}: changed`
    })
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as RevisionValue)
}
