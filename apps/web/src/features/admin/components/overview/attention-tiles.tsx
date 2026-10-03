import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { formatCount } from '@/features/admin/lib/format'
import { attentionTiles, nothingNeedsAPerson } from '@/features/admin/lib/overview-links'
import type { AttentionCounts } from '@/features/admin/queries/attention'

/**
 * Inside a card, a tile is a lighter well rather than a second card; its
 * right padding keeps a wrapped label clear of the link's arrow.
 */
export const INNER_TILE = 'rounded-2xl bg-background/70 pr-10 shadow-none dark:bg-background/40'

/**
 * What needs a person on this side (docs/ADMIN-SPEC.md §5.2 B1): each queue
 * a tile whose whole face links to the list, filtered to what was counted —
 * the count is inside the link's name ("Stuck orders 2").
 */
export function AttentionTiles({ counts }: { counts: AttentionCounts }) {
  const tiles = attentionTiles(counts)
  return (
    <Panel labelledBy="overview-attention-heading">
      <h2 id="overview-attention-heading" className={PANEL_HEADING}>
        Needs a person
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {nothingNeedsAPerson(counts)
          ? 'Nothing needs a person on this side right now.'
          : 'Each tile opens its list, filtered to what is counted here.'}
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile) => (
          <li key={tile.key} data-attention={tile.key} className="min-w-0">
            <StatTile
              label={tile.label}
              value={formatCount(tile.value)}
              hint={tile.hint}
              href={tile.href}
              tone={tile.tone}
              className={`h-full ${INNER_TILE}`}
            />
          </li>
        ))}
      </ul>
    </Panel>
  )
}
