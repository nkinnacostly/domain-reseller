import Link from 'next/link'
import { Suspense } from 'react'
import {
  FOCUS,
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelSkeleton,
} from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { formatWat } from '@/features/admin/lib/format'
import {
  DECISION_LABEL,
  OPEN_EMPTY,
  OPEN_HEADING,
  REVIEWED_EMPTY,
  REVIEWED_HEADING,
  SCREENING_DESCRIPTION,
  SCREENING_TITLE,
  screenedSummary,
} from '@/features/admin/lib/screening-copy'
import type { AdminSide } from '@/features/admin/lib/side'
import { getScreenings, type ScreeningRow } from '@/features/admin/queries/screening'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { ReviewScreening } from './review-screening'

/**
 * `/admin/screening` (migration 73): new paid names the screening passed to a
 * person, with "Looks fine" and "Abuse" for each, and what was reviewed in
 * the last 30 days. Read and review only — nothing here holds an order.
 */
export async function ScreeningView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: SCREENING_TITLE }]}
        title={SCREENING_TITLE}
        description={SCREENING_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <Suspense fallback={<PanelSkeleton height="h-72" />}>
        <ScreeningLists admin={admin} side={side} />
      </Suspense>
    </PanelPage>
  )
}

export async function ScreeningLists({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const data = await getScreenings(admin, side)
  if (!data) return <ErrorState title="The name checks couldn't be loaded." />
  const canReview = admin.role !== 'viewer'
  return (
    <>
      <Panel labelledBy="screening-open-heading">
        <h2 id="screening-open-heading" className={PANEL_HEADING}>
          {OPEN_HEADING}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {screenedSummary(data.screened, data.cleared)}
        </p>
        {data.open.length === 0 ? (
          <Empty>{OPEN_EMPTY}</Empty>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {data.open.map((row) => (
              <li
                key={row.orderItemId}
                id={`line-${row.orderItemId}`}
                className="scroll-mt-24 py-4 first:pt-0 last:pb-0"
              >
                <Facts row={row} />
                {canReview ? (
                  <div className="mt-3">
                    <ReviewScreening
                      orderItemId={row.orderItemId}
                      domain={row.domain}
                      matched={row.matched}
                      note={row.note}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel labelledBy="screening-reviewed-heading">
        <h2 id="screening-reviewed-heading" className={PANEL_HEADING}>
          {REVIEWED_HEADING}
        </h2>
        {data.reviewed.length === 0 ? (
          <Empty>{REVIEWED_EMPTY}</Empty>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {data.reviewed.map((row) => (
              <li
                key={row.orderItemId}
                id={`line-${row.orderItemId}`}
                className="scroll-mt-24 py-4 first:pt-0 last:pb-0"
              >
                <Facts row={row} />
                <p className="mt-2 text-sm">
                  <AdminStatusPill
                    value={row.decision ?? ''}
                    labels={DECISION_LABEL}
                    tone={row.decision === 'abuse' ? 'danger' : 'ok'}
                  />{' '}
                  <span className="text-muted-foreground">
                    by {row.reviewedBy ?? '—'}, {formatWat(row.reviewedAt)}:
                  </span>{' '}
                  <span className="break-words">{row.reviewNote}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}

function Facts({ row }: { row: ScreeningRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-all font-medium text-foreground">{row.domain}</p>
      <p className="text-sm text-muted-foreground">
        Matched {row.matched.join(', ') || 'nothing listed'} · screened {formatWat(row.screenedAt)}
        {row.orderId ? (
          <>
            {' · '}
            <Link
              href={`/admin/orders/${row.orderId}`}
              className={cn('underline underline-offset-4', FOCUS)}
            >
              Open the order
            </Link>
          </>
        ) : null}
      </p>
      {row.note ? (
        <p className="text-sm">
          <span className="text-muted-foreground">
            {row.model ? 'The model said:' : 'Screening note:'}
          </span>{' '}
          {row.note}
        </p>
      ) : null}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-2xl border border-border border-dashed bg-background/70 px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}
