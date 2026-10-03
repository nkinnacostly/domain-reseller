import type { Tone } from '@/features/admin/lib/tone'
import type { AttentionCounts } from '@/features/admin/queries/attention'

/**
 * The overview's "needs a person" tiles (docs/ADMIN-SPEC.md §5.2 B1): one
 * per queue a person works, each linking to its page with the filter that
 * shows exactly what was counted (`admin_attention_counts`). Links carry
 * statuses and tabs only — never a name or an email (N13).
 */

export type AttentionTile = {
  key: keyof AttentionCounts
  label: string
  value: number
  href: string
  /** Plain text, read with the link's name. */
  hint?: string
  tone: Tone
}

type Spec = {
  key: keyof AttentionCounts
  label: string
  href: string
  /** How a non-zero count looks: danger when money or a customer's order is at stake now. */
  tone: Tone
  hint?: (counts: AttentionCounts) => string | undefined
}

/** In the order a person should work them. */
export const ATTENTION_SPECS: readonly Spec[] = [
  {
    key: 'refunds',
    label: 'Refunds needing a person',
    // admin_attention_counts: held, failed and needs_attention refunds.
    href: '/admin/refunds?status=held,failed,needs_attention',
    tone: 'warning',
  },
  {
    key: 'jobs',
    label: 'Jobs needing a person',
    href: '/admin/queue?status=needs_attention',
    tone: 'danger',
    // admin_attention_counts adds certificate jobs to domain jobs; the link
    // opens the domain jobs, so say where the rest are.
    hint: (counts) =>
      counts.jobs > 0
        ? 'Domain and certificate jobs; each has its own tab in the queue'
        : undefined,
  },
  {
    key: 'alertsCritical',
    label: 'Critical alerts',
    href: '/admin/alerts?severity=critical',
    tone: 'danger',
    hint: (counts) =>
      counts.alertsWarning > 0
        ? `Plus ${counts.alertsWarning} ${counts.alertsWarning === 1 ? 'warning' : 'warnings'}`
        : undefined,
  },
  {
    key: 'drift',
    label: 'Registry differences',
    href: '/admin/alerts?tab=drift',
    tone: 'warning',
  },
  {
    key: 'incidents',
    label: 'Payment incidents',
    // The incidents list opens on the unresolved ones (`?state=open` is its default).
    href: '/admin/refunds/incidents',
    tone: 'warning',
  },
  {
    key: 'stuckOrders',
    label: 'Stuck orders',
    href: '/admin/orders?stuck=1',
    tone: 'warning',
  },
  {
    key: 'pendingWithoutJob',
    label: 'Paid lines with no job',
    href: '/admin/queue/pending',
    tone: 'danger',
  },
  {
    key: 'emailsFailed',
    label: 'Failed emails',
    href: '/admin/emails?status=failed',
    tone: 'warning',
  },
  {
    key: 'ledgerUnexplained',
    label: 'Unexplained supplier charges',
    href: '/admin/supplier/ledger?status=unexplained',
    tone: 'danger',
  },
  {
    key: 'presetDrafts',
    label: 'Preset drafts',
    href: '/admin/settings/presets?status=draft',
    tone: 'info',
  },
]

/** The tiles with their counts; a zero is shown, quietly, so the row never shifts. */
export function attentionTiles(counts: AttentionCounts): AttentionTile[] {
  return ATTENTION_SPECS.map((spec) => {
    const value = counts[spec.key]
    return {
      key: spec.key,
      label: spec.label,
      value,
      href: spec.href,
      hint: spec.hint?.(counts),
      tone: value > 0 ? spec.tone : 'neutral',
    }
  })
}

/** True when nothing on this side needs a person — warnings included. */
export function nothingNeedsAPerson(counts: AttentionCounts): boolean {
  return counts.alertsWarning === 0 && ATTENTION_SPECS.every((spec) => counts[spec.key] === 0)
}
