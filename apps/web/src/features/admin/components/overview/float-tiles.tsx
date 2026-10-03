import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { formatUsd } from '@/features/admin/lib/format'
import type { FloatState } from '@/features/admin/lib/overview-data'
import {
  runwayLine,
  snapshotLine,
  targetKnown,
  targetLine,
} from '@/features/admin/lib/overview-float'
import { INNER_TILE } from './attention-tiles'

/**
 * The supplier float (docs/ADMIN-SPEC.md §5.2 B1, §6; FR-FLOAT-2, FR-FLOAT-4):
 * the balance with its runway, and the 21-day target. Both open the
 * Supplier page, where the ledger and top-ups behind them live.
 */
export function FloatTiles({ float, now }: { float: FloatState; now: Date }) {
  const runway = runwayLine(float, now)
  const target = targetLine(float)
  const taken = snapshotLine(float, now)
  const uncosted =
    float.uncostedLines > 0
      ? ` ${float.uncostedLines} paid ${float.uncostedLines === 1 ? 'line is' : 'lines are'} counted at today's prices.`
      : ''
  return (
    <Panel labelledBy="overview-float-heading">
      <h2 id="overview-float-heading" className={PANEL_HEADING}>
        Supplier float
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        DomainNameAPI balance on this side, in US dollars.{uncosted}
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <li className="min-w-0" data-float="balance">
          <StatTile
            label="Balance and runway"
            value={formatUsd(float.balanceCents)}
            hint={taken ? `${runway.text}. ${taken}.` : `${runway.text}.`}
            href="/admin/supplier"
            tone={runway.tone}
            className={`h-full ${INNER_TILE}`}
          />
        </li>
        <li className="min-w-0" data-float="target">
          <StatTile
            label="21-day target"
            value={targetKnown(float) ? formatUsd(float.target21dCents) : '—'}
            hint={target.text}
            href="/admin/supplier"
            tone={target.tone}
            className={`h-full ${INNER_TILE}`}
          />
        </li>
      </ul>
    </Panel>
  )
}
