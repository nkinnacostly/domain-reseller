import { failureReason } from './registration'

/**
 * Bulk actions (PRD FR-P4, FR-N2): one request, a line per domain, and each
 * line's outcome in words. `start_bulk_change` (migration 32) applies the
 * change exactly as the one-domain actions do — a registry change becomes a
 * queued job per domain, whose status is the line's; auto-renew and labels
 * are applied at once — and says why any domain was skipped.
 */

export const BULK_KINDS = [
  'nameservers',
  'transfer_lock',
  'privacy',
  'auto_renew',
  'label',
  'unlabel',
] as const
export type BulkKind = (typeof BULK_KINDS)[number]

/** The database takes at most this many domains in one bulk action. */
export const BULK_MAX = 500

/** One domain's line, as `my_bulk_operation` returns it. */
export type BulkLine = {
  domainId: string
  domainName: string
  outcome: 'queued' | 'done' | 'skipped'
  reason: string | null
  /** The job's status, for a queued line; null once the job is gone. */
  jobStatus: string | null
  jobErrorCode: string | null
}

/** What a line comes to, for its tone and the summary. */
export type LineState = 'done' | 'waiting' | 'attention' | 'failed' | 'unchanged' | 'skipped'

export function lineState(line: BulkLine): LineState {
  if (line.outcome === 'done') return 'done'
  if (line.outcome === 'skipped') return line.reason === 'unchanged' ? 'unchanged' : 'skipped'
  switch (line.jobStatus) {
    case 'succeeded':
      return 'done'
    case 'failed':
      return 'failed'
    case 'needs_attention':
      return 'attention'
    default:
      return 'waiting'
  }
}

/** Still moving: the results page refreshes itself until every job has settled. */
export function isBulkSettling(lines: readonly BulkLine[]): boolean {
  return lines.some(
    (line) =>
      line.outcome === 'queued' && (line.jobStatus === 'queued' || line.jobStatus === 'running'),
  )
}

export function bulkSummary(lines: readonly BulkLine[]): Record<LineState, number> {
  const counts: Record<LineState, number> = {
    done: 0,
    waiting: 0,
    attention: 0,
    failed: 0,
    unchanged: 0,
    skipped: 0,
  }
  for (const line of lines) counts[lineState(line)] += 1
  return counts
}

/** What was asked for, as stored with the operation (`p_value`). */
export type BulkParams = {
  nameservers?: unknown
  locked?: unknown
  enabled?: unknown
  label_id?: unknown
}

const onOff = (value: unknown) => (value ? 'on' : 'off')

const plural = (count: number) => `${count} ${count === 1 ? 'domain' : 'domains'}`

/** The page's title: what was asked, and of how many domains. */
export function bulkTitle(
  kind: BulkKind,
  params: BulkParams,
  count: number,
  labelName: string | null = null,
): string {
  const label = labelName ? `“${labelName}”` : 'a label'
  switch (kind) {
    case 'nameservers':
      return `New nameservers for ${plural(count)}`
    case 'transfer_lock':
      return `Transfer lock ${onOff(params.locked)} for ${plural(count)}`
    case 'privacy':
      return `Contact privacy ${onOff(params.enabled)} for ${plural(count)}`
    case 'auto_renew':
      return `Auto-renew ${onOff(params.enabled)} for ${plural(count)}`
    case 'label':
      return `Label ${label} added to ${plural(count)}`
    case 'unlabel':
      return `Label ${label} removed from ${plural(count)}`
  }
}

/** The facts a line's wording needs about its domain, read as the user. */
export type LineDomain = { source: string; status: string }

const extensionOf = (name: string) => name.split('.').slice(1).join('.')

function unchangedText(kind: BulkKind, params: BulkParams): string {
  switch (kind) {
    case 'nameservers':
      return 'It already uses those nameservers.'
    case 'transfer_lock':
      return params.locked ? 'It is already locked.' : 'It is already unlocked.'
    case 'privacy':
      return `Contact privacy is already ${onOff(params.enabled)}.`
    case 'auto_renew':
      return `Auto-renew is already ${onOff(params.enabled)}.`
    case 'label':
      return 'It already had this label.'
    case 'unlabel':
      return 'It did not have this label.'
  }
}

function doneText(kind: BulkKind, params: BulkParams, domain: LineDomain | undefined): string {
  switch (kind) {
    case 'nameservers':
      // Applied here only when there is no registry to send it to yet (FR-R5).
      if (domain?.source === 'demo') {
        return 'Saved. This is a demo domain, so nothing is sent to a registry.'
      }
      return 'Saved. Applied as soon as the registration completes.'
    case 'auto_renew':
      return `Auto-renew turned ${onOff(params.enabled)}.`
    case 'label':
      return 'Label added.'
    case 'unlabel':
      return 'Label removed.'
    default:
      return 'The registry confirmed it.'
  }
}

/**
 * One line in words, after its state ("Done.", "Skipped."): what happened
 * to this domain, and — for anything that did not happen — why, never the
 * supplier's own text (N10).
 */
export function describeLine(
  kind: BulkKind,
  params: BulkParams,
  line: BulkLine,
  domain?: LineDomain,
): string {
  if (line.outcome === 'done') return doneText(kind, params, domain)
  if (line.outcome === 'skipped') {
    switch (line.reason) {
      case 'unchanged':
        return unchangedText(kind, params)
      case 'demo':
        return 'A demo domain never reaches a registry.'
      case 'registering':
        return 'It is still registering. Change it once the registration completes.'
      case 'not_active':
        return kind === 'nameservers'
          ? 'Nameservers can only be changed on an active domain.'
          : 'Only a registered domain can be changed.'
      case 'change_waiting':
        return 'A change is already on its way to the registry.'
      case 'not_offered':
        return `Contact privacy is not offered for .${extensionOf(line.domainName)} domains.`
      default:
        return 'It was left as it is.'
    }
  }
  switch (line.jobStatus) {
    case 'queued':
      return 'Queued for the registry.'
    case 'running':
      return 'Being applied at the registry now.'
    case 'succeeded':
      return 'The registry confirmed it.'
    case 'needs_attention':
      return 'Held for a person to check at the registry. Nothing is needed from you.'
    case 'failed':
      return failureReason(line.jobErrorCode)
    default:
      return 'Sent to the registry.'
  }
}

export const STATE_LABEL: Record<LineState, string> = {
  done: 'Done',
  waiting: 'Waiting',
  attention: 'Needs a person',
  failed: 'Failed',
  unchanged: 'Already set',
  skipped: 'Skipped',
}
