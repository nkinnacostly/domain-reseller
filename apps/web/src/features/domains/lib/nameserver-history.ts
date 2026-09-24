import { sameNameservers } from './nameserver-check'

/**
 * FR-N5 — every change of a domain's nameservers, with who asked where we
 * know. The history itself is kept by a trigger on `domains` (migration 32)
 * whoever made the change: a job applying a request, the hourly reconcile
 * copying the registry, or a registration. The activity log says which:
 * `nameservers_requested` carries who asked and the set asked for, and
 * `nameservers_synced` marks a change found at the registry.
 */

export type HistoryRow = { before: string[] | null; after: string[]; changedAt: string }

export type NameserverEvent = {
  type: string
  actorType: string
  payload: Record<string, unknown>
  createdAt: string
}

/** Where a change came from, as far as the activity log can say. */
export type ChangeSource =
  | { kind: 'request'; by: 'you' | 'support' | 'us'; requestedAt: string }
  | { kind: 'registry' }
  | { kind: 'first' }
  | { kind: 'unknown' }

export type HistoryEntry = HistoryRow & { source: ChangeSource }

const setOf = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null

const BY: Record<string, 'you' | 'support' | 'us'> = { user: 'you', support: 'support' }

/** A sync is written in the same transaction as the change, so within a minute of it. */
const SAME_MOMENT_MS = 60_000

/**
 * Each change with its source: the newest request for that same set made
 * before the change took effect; otherwise a sync from the registry at that
 * moment; otherwise the first set a domain was given. Newest first, as read.
 */
export function attributeHistory(
  history: readonly HistoryRow[],
  events: readonly NameserverEvent[],
): HistoryEntry[] {
  const newestFirst = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return history.map((row) => {
    const at = new Date(row.changedAt).getTime()
    const request = newestFirst.find(
      (event) =>
        event.type === 'nameservers_requested' &&
        new Date(event.createdAt).getTime() <= at + SAME_MOMENT_MS &&
        sameNameservers(setOf(event.payload.after), row.after),
    )
    if (request) {
      return {
        ...row,
        source: {
          kind: 'request',
          by: BY[request.actorType] ?? 'us',
          requestedAt: request.createdAt,
        },
      }
    }
    const synced = newestFirst.some(
      (event) =>
        event.type === 'nameservers_synced' &&
        Math.abs(new Date(event.createdAt).getTime() - at) <= SAME_MOMENT_MS,
    )
    if (synced) return { ...row, source: { kind: 'registry' } }
    if (!row.before?.length) return { ...row, source: { kind: 'first' } }
    return { ...row, source: { kind: 'unknown' } }
  })
}

/**
 * The set a one-click revert asks for, or null when there is nothing to go
 * back to. A revert is an ordinary request (FR-N5 through FR-D4), so it is
 * offered only where a request could be made. `waiting` when that set is
 * already on its way — asked for, not yet applied — so there is nothing to
 * click, only something to say.
 */
export function revertTarget(domain: {
  status: string
  previousNameservers: string[] | null
  nameservers: string[] | null
  pendingNameservers: string[] | null
}): { nameservers: string[]; waiting: boolean } | null {
  const previous = domain.previousNameservers
  if (!previous?.length) return null
  if (domain.status !== 'active' && domain.status !== 'pending') return null
  return {
    nameservers: previous,
    waiting: sameNameservers(previous, domain.pendingNameservers ?? domain.nameservers),
  }
}
