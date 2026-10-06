import { StatusPill } from '@/components/common/status-pill'
import {
  findingKindOf,
  formatCount,
  formatPpm,
  formatWhen,
  RESOLUTION,
} from '@/features/admin/lib/format'
import type { Finding, SesFinding } from '@/features/admin/queries/mail'
import { Card } from './parts'

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** What a threshold finding measured, in words: rates, counts and the window. */
export function findingFacts(finding: Finding): string | null {
  if (finding.source !== 'threshold') return null
  const d = finding.detail
  const sent = num(d.sent)
  if (sent === null) return null
  return `Bounces ${formatPpm(num(d.bouncePpm))}, complaints ${formatPpm(num(d.complaintPpm))} over ${
    num(d.windowDays) ?? 7
  } days (${formatCount(sent)} sent)`
}

/**
 * The findings a resume must be read against (MAIL-SPEC §7.4, MR5): ours —
 * the threshold's warnings and pauses, an admin's pause — and SES's own, as
 * the events endpoint recorded them. Open ones first.
 */
export function AccountFindings({
  findings,
  sesFindings,
}: {
  findings: Finding[]
  sesFindings: SesFinding[]
}) {
  return (
    <Card title="Findings" id="findings-heading">
      {findings.length === 0 && sesFindings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No finding has been opened on this account.</p>
      ) : (
        <ul className="divide-y divide-border">
          {findings.map((f) => {
            const open = f.resolvedAt === null
            const facts = findingFacts(f)
            return (
              <li key={`ours-${f.id}`} className="py-3" data-finding={f.kind}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    tone={!open ? 'neutral' : f.severity === 'pause' ? 'danger' : 'warning'}
                  >
                    {open ? (f.severity === 'pause' ? 'Open: paused' : 'Open: warning') : 'Closed'}
                  </StatusPill>
                  <span className="font-medium">{findingKindOf(f.kind)}</span>
                </div>
                {facts ? <p className="mt-1 text-sm">{facts}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  Opened {formatWhen(f.openedAt)}
                  {f.resolvedAt
                    ? ` · ${RESOLUTION[f.resolution ?? ''] ?? 'Closed'} ${formatWhen(f.resolvedAt)}${
                        f.resolvedBy && f.resolvedBy !== 'system' ? ` by ${f.resolvedBy}` : ''
                      }`
                    : ''}
                </p>
              </li>
            )
          })}
          {sesFindings.map((f) => {
            const open = f.resolvedAt === null
            return (
              <li key={`ses-${f.id}`} className="py-3" data-finding={f.kind}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={open ? 'danger' : 'neutral'}>
                    {open ? 'Open: from SES' : 'Closed: from SES'}
                  </StatusPill>
                  <span className="font-medium">{findingKindOf(f.kind)}</span>
                  {f.impact ? (
                    <span className="text-xs text-muted-foreground">Impact: {f.impact}</span>
                  ) : null}
                </div>
                {f.summary ? <p className="mt-1 text-sm break-words">{f.summary}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  Opened {formatWhen(f.openedAt)}
                  {f.resolvedAt ? ` · resolved ${formatWhen(f.resolvedAt)}` : ''}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
