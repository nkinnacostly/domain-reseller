import { DEFAULT_CROSS_CHECK_TOLERANCE_PCT } from '@dr/shared'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { canAct } from '@/features/admin/lib/actions'
import { ago, formatWat } from '@/features/admin/lib/format'
import {
  activateCopy,
  arrivalWords,
  BLOCK_DETAIL,
  chargedWords,
  FX_DESCRIPTION,
  FX_STATUS_LABEL,
  FX_STATUS_TONE,
  formatMove,
  formatPercent,
  formatRate,
  NO_ACTIVE_RATE,
  noneHeldWords,
  OWNER_ONLY_RATES,
  rateHeading,
  rejectCopy,
  STATUS_ERROR,
  TOO_OLD,
} from '@/features/admin/lib/pricing-copy'
import type {
  PendingRate,
  PricingSettings,
  RateRow,
  SampleTld,
} from '@/features/admin/lib/pricing-data'
import {
  chargedRate,
  movePct,
  priceEffect,
  pricingInputs,
  rateOffers,
} from '@/features/admin/lib/pricing-rules'
import { getCurrentRates, getPricingStatus, getRecentRates } from '@/features/admin/queries/pricing'
import { type AdminPrincipal, requireAdmin } from '@/features/admin/queries/session'
import { PricingHeader, PricingSectionsSkeleton } from './pricing-header'
import { RateActions } from './rate-actions'

/**
 * `/admin/pricing/fx` (docs/ADMIN-SPEC.md §5.2 B12): the active rate, every
 * rate the FX job held for review — with the move it was held for and the
 * move from the active rate now, and both quote times — and the latest
 * rates. A held rate quoted 48 hours ago or more, or before the active one,
 * offers Reject only. The page shows whatever state the table holds.
 */
export async function FxView() {
  const admin = await requireAdmin()
  return (
    <PanelPage>
      <PricingHeader title="Exchange rates" description={FX_DESCRIPTION} />
      <Suspense fallback={<PricingSectionsSkeleton cards={3} />}>
        <FxSections admin={admin} />
      </Suspense>
    </PanelPage>
  )
}

type Charged = RateRow & { charged: number }

/** A held rate, with what may be done with it and the words for doing it. */
export type HeldRate = {
  row: Charged
  offers: ReturnType<typeof rateOffers>
  moveNow: number | null
}

/**
 * The held rates, newest first: the rows, with SQL's own review flags where
 * `admin_pricing_status` gave them, judged again against the clock.
 */
export function heldRates(
  rows: RateRow[],
  pending: PendingRate[],
  active: Charged | null,
  now: Date,
): HeldRate[] {
  return rows
    .filter((row) => row.status === 'pending_review')
    .map((row) => {
      const flags = pending.find((rate) => rate.id === row.id)
      return {
        row: { ...row, charged: chargedRate(row) },
        offers: rateOffers({ ...flags, quotedAt: row.quotedAt }, active, now),
        moveNow: movePct(row.costingRate, active?.costingRate),
      }
    })
}

export async function FxSections({ admin, now }: { admin: AdminPrincipal; now?: Date }) {
  const [status, rates, recent] = await Promise.all([
    getPricingStatus(),
    getCurrentRates(admin),
    getRecentRates(admin),
  ])
  if (!status || !rates) return <ErrorState title={STATUS_ERROR.title} body={STATUS_ERROR.body} />
  const sample = status.example
  // After the session's reads, so the clock is this request's (CLAUDE.md §15).
  const clock = now ?? new Date()
  const activeRow = rates.find((rate) => rate.status === 'active')
  const active: Charged | null = activeRow
    ? { ...activeRow, charged: chargedRate(activeRow) }
    : null
  const threshold = status.settings?.fxMoveThresholdPct ?? null
  const held = heldRates(rates, status.fx.pending, active, clock)

  return (
    <>
      <Panel labelledBy="fx-active-heading">
        <h2 id="fx-active-heading" className={PANEL_HEADING}>
          Active rate
        </h2>
        {active ? (
          <DlGrid
            className="mt-4"
            items={[
              { label: 'Rate', value: `${formatRate(active.costingRate)} to the dollar` },
              {
                label: 'Prices are built at',
                value: chargedWords(active.costingRate, active.bufferPct, active.charged),
              },
              { label: 'Source', value: active.source },
              {
                label: 'Quoted',
                value: `${formatWat(active.quotedAt)} (${ago(active.quotedAt, clock)})`,
              },
              { label: 'Active since', value: formatWat(active.effectiveFrom) },
            ]}
          />
        ) : (
          <p className="mt-3 text-sm text-foreground">{NO_ACTIVE_RATE}</p>
        )}
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          {arrivalWords(DEFAULT_CROSS_CHECK_TOLERANCE_PCT, threshold)}
        </p>
      </Panel>

      <Panel labelledBy="fx-held-heading">
        <h2 id="fx-held-heading" className={PANEL_HEADING}>
          Held for review ({held.length})
        </h2>
        {held.length > 0 && !canAct(admin, 'fx.activate') ? (
          <p className="mt-3 max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
            {OWNER_ONLY_RATES}
          </p>
        ) : null}
        {held.length === 0 ? (
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{noneHeldWords(threshold)}</p>
        ) : (
          <ul aria-label="Rates held for review" className="mt-4 space-y-3">
            {held.map((rate) => (
              <HeldRateCard
                key={rate.row.id}
                rate={rate}
                active={active}
                settings={status.settings}
                sample={sample}
                now={clock}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel labelledBy="fx-recent-heading">
        <h2 id="fx-recent-heading" className={PANEL_HEADING}>
          Recent rates
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-sm text-muted-foreground">
          The latest rates the FX job stored, newest first. A rate is never edited: a new one
          replaces it.
        </p>
        {recent ? (
          <DataTable
            caption="The latest exchange rates, newest first"
            rows={recent}
            rowKey={(row) => row.id}
            columns={RECENT_COLUMNS}
            empty={<EmptyState title="No rates yet" body={NO_ACTIVE_RATE} />}
          />
        ) : (
          <ErrorState title="The latest rates couldn't be loaded." />
        )}
      </Panel>
    </>
  )
}

const RECENT_COLUMNS: Column<RateRow>[] = [
  {
    key: 'rate',
    header: 'Rate',
    cell: (row) => <span className="tabular-nums">{rateHeading(row.costingRate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <AdminStatusPill
        value={row.status}
        labels={FX_STATUS_LABEL}
        tone={FX_STATUS_TONE[row.status] ?? 'neutral'}
      />
    ),
  },
  { key: 'buffer', header: 'Buffer', numeric: true, cell: (row) => formatPercent(row.bufferPct) },
  { key: 'move', header: 'Move', numeric: true, cell: (row) => formatMove(row.movePct) },
  { key: 'source', header: 'Source', cell: (row) => row.source },
  { key: 'quoted', header: 'Quoted', cell: (row) => formatWat(row.quotedAt) },
  { key: 'from', header: 'Active from', cell: (row) => formatWat(row.effectiveFrom) },
]

/** One held rate: its facts, why Activate is not offered when it isn't, and its actions. */
export function HeldRateCard({
  rate,
  active,
  settings,
  sample,
  now,
}: {
  rate: HeldRate
  active: Charged | null
  settings: PricingSettings | null
  sample: SampleTld | null
  now: Date
}) {
  const { row, offers, moveNow } = rate
  const effect = priceEffect(
    sample?.onSale ? sample : null,
    pricingInputs(active, settings),
    pricingInputs(row, settings),
  )
  return (
    <li data-rate-id={row.id} className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-foreground tabular-nums">{rateHeading(row.costingRate)}</h3>
        <AdminStatusPill
          value={offers.activate ? 'ready' : 'blocked'}
          tone={offers.activate ? 'info' : 'neutral'}
          labels={{ ready: 'Ready to review', blocked: 'Too old to activate' }}
        />
      </div>
      <DlGrid
        className="mt-3"
        items={[
          { label: 'Source', value: row.source },
          { label: 'Quoted', value: `${formatWat(row.quotedAt)} (${ago(row.quotedAt, now)})` },
          {
            label: 'Active rate quoted',
            value: active ? formatWat(active.quotedAt) : 'No active rate',
          },
          { label: 'Move when it was fetched', value: formatMove(row.movePct) },
          { label: 'Move from the active rate now', value: formatMove(moveNow) },
          {
            label: 'Prices would be built at',
            value: chargedWords(row.costingRate, row.bufferPct, row.charged),
          },
          { label: 'Why it was held', value: row.reviewReason ?? '—', wide: true },
        ]}
      />
      {offers.blockedBy ? (
        <p className="mt-3 text-sm text-foreground">
          {TOO_OLD} <span className="text-muted-foreground">{BLOCK_DETAIL[offers.blockedBy]}</span>
        </p>
      ) : null}
      <div className="mt-4">
        <RateActions
          rateId={row.id}
          rateLabel={formatRate(row.costingRate)}
          activate={
            offers.activate ? activateCopy({ rate: row, active, move: moveNow, effect }) : null
          }
          reject={rejectCopy({ rate: row, reviewReason: row.reviewReason, active })}
        />
      </div>
    </li>
  )
}
