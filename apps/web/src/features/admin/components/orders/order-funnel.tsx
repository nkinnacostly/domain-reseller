import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import { FUNNEL_ERROR } from '@/features/admin/lib/orders-copy'
import { waitText } from '@/features/admin/lib/orders-format'
import type { OrderFunnel } from '@/features/admin/queries/orders'

/**
 * Where orders get to over the range (`admin_funnel`, ADMIN-SPEC §6): from a
 * name put in a cart to an order settled. Cart adds are counted only since
 * counting began, and say so; searches are never counted (FR-S7).
 */
export function OrderFunnelStrip({
  funnel,
  range,
}: {
  funnel: OrderFunnel | null
  range: { from: string; to: string }
}) {
  if (!funnel) return <ErrorState title={FUNNEL_ERROR} />
  const span = `${formatWatDate(range.from)} – ${formatWatDate(range.to)}`
  const stages: { label: string; value: string; hint?: string }[] = [
    {
      label: 'Cart adds',
      value: formatCount(funnel.cartAdds),
      hint: funnel.cartAddsSince
        ? `counted since ${formatWatDate(funnel.cartAddsSince)}`
        : 'not counted yet',
    },
    { label: 'Orders placed', value: formatCount(funnel.created) },
    { label: 'Paid', value: formatCount(funnel.paid) },
    { label: 'Completed', value: formatCount(funnel.completed) },
    { label: 'Partly failed', value: formatCount(funnel.partial) },
    { label: 'Failed', value: formatCount(funnel.failed) },
    { label: 'Cancelled', value: formatCount(funnel.cancelled) },
    { label: 'Awaiting payment', value: formatCount(funnel.awaiting) },
    { label: 'Still settling', value: formatCount(funnel.inFlight) },
    { label: 'Median time to pay', value: waitText(funnel.medianSecsToPay) },
    { label: 'Median time to settle', value: waitText(funnel.medianSecsToSettle) },
  ]
  return (
    <Panel labelledBy="orders-funnel-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="orders-funnel-heading" className={PANEL_HEADING}>
          Funnel
        </h2>
        <p className="text-sm text-muted-foreground">Orders placed {span} (WAT)</p>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {stages.map((stage) => (
          <div key={stage.label} className="min-w-0">
            <dt className="text-sm text-muted-foreground">{stage.label}</dt>
            <dd className="mt-0.5 text-xl font-light tracking-tight text-foreground tabular-nums">
              {stage.value}
            </dd>
            {stage.hint ? <dd className="text-xs text-muted-foreground">{stage.hint}</dd> : null}
          </div>
        ))}
      </dl>
    </Panel>
  )
}
