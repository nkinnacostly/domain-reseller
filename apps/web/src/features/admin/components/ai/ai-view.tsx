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
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { StatTile } from '@/features/admin/components/stat-tile'
import { DataTable } from '@/features/admin/components/table/data-table'
import {
  AI_DESCRIPTION,
  AI_TITLE,
  AI_WINDOW_DAYS,
  BUDGET_LINK,
  budgetWords,
  bulkWords,
  COLUMNS,
  callsWords,
  copilotWords,
  DAILY_TITLE,
  FEATURES_CAPTION,
  featureLabel,
  helpWords,
  IMPACT_HEADING,
  IMPACT_INTRO,
  MEASURE,
  NOT_MEASURED,
  PHASES,
  pointedWords,
  REPORT_ERROR,
  SPEND_EMPTY,
  SPEND_ESTIMATE_NOTE,
  SPEND_HEADING,
  SPEND_HIDDEN,
  screeningWords,
  shareWords,
} from '@/features/admin/lib/ai-copy'
import {
  type AiFeatureRow,
  type AiReport,
  dailySeries,
  outcomes,
  usdFromMicro,
} from '@/features/admin/lib/ai-report'
import { formatCount, formatUsd, formatWatDate } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import { getAiReport, watWindow } from '@/features/admin/queries/ai'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

/**
 * `/admin/ai` (AI phase 4, migration 75): what the AI features cost against
 * the monthly budget, and each phase of the AI plan against the number it
 * named. Read only.
 */
export async function AiView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: AI_TITLE }]}
        title={AI_TITLE}
        description={AI_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <Suspense fallback={<PanelSkeleton height="h-96" />}>
        <AiPanels side={side} now={new Date()} />
      </Suspense>
    </PanelPage>
  )
}

export async function AiPanels({ side, now }: { side: AdminSide; now: Date }) {
  const window = watWindow(now, AI_WINDOW_DAYS)
  const report = await getAiReport(side, window)
  if (!report) return <ErrorState title={REPORT_ERROR} />
  return (
    <>
      <Spend report={report} window={window} />
      <Impact report={report} />
    </>
  )
}

function Spend({ report, window }: { report: AiReport; window: { from: string; to: string } }) {
  const spend = report.spend
  return (
    <Panel labelledBy="ai-spend-heading">
      <h2 id="ai-spend-heading" className={PANEL_HEADING}>
        {SPEND_HEADING}
      </h2>
      {!spend ? (
        <p className="mt-2 text-sm text-muted-foreground">{SPEND_HIDDEN}</p>
      ) : (
        <SpendBody spend={spend} window={window} />
      )}
    </Panel>
  )
}

function SpendBody({
  spend,
  window,
}: {
  spend: NonNullable<AiReport['spend']>
  window: { from: string; to: string }
}) {
  const windowMicro = spend.features.reduce((sum, row) => sum + row.costMicro, 0)
  const calls = spend.features.reduce((sum, row) => sum + row.calls, 0)
  const over = spend.monthMicro > spend.budgetCents * 10_000
  const budget = formatUsd(spend.budgetCents)
  return (
    <div className="mt-4 space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="This month (WAT)"
          value={usdFromMicro(spend.monthMicro)}
          hint={`Budget ${budget}`}
          tone={over ? 'warning' : 'neutral'}
        />
        <StatTile label="Last 30 days" value={usdFromMicro(windowMicro)} />
        <StatTile label="Calls, last 30 days" value={formatCount(calls)} />
      </div>
      <p className="text-sm text-muted-foreground">
        {budgetWords(usdFromMicro(spend.monthMicro), budget)}{' '}
        <Link
          href="/admin/settings"
          className={cn('font-medium text-foreground underline underline-offset-4', FOCUS)}
        >
          {BUDGET_LINK}
        </Link>
        .
      </p>
      {calls === 0 ? (
        <p className="text-sm text-muted-foreground">{SPEND_EMPTY}</p>
      ) : (
        <>
          <BarChart
            title={DAILY_TITLE}
            data={dailySeries(spend.daily, window.from, window.to).map((entry) => ({
              key: entry.day,
              label: formatWatDate(`${entry.day}T12:00:00Z`),
              value: entry.costMicro,
            }))}
            format={usdFromMicro}
          />
          <DataTable
            caption={FEATURES_CAPTION}
            rows={spend.features}
            rowKey={(row) => row.feature}
            empty={null}
            columns={[
              { key: 'feature', header: COLUMNS.feature, cell: (row) => featureLabel(row.feature) },
              {
                key: 'calls',
                header: COLUMNS.calls,
                numeric: true,
                cell: (row) => formatCount(row.calls),
              },
              {
                key: 'failed',
                header: COLUMNS.failed,
                numeric: true,
                cell: (row) => formatCount(row.failed),
              },
              {
                key: 'declined',
                header: COLUMNS.declined,
                numeric: true,
                cell: (row) => formatCount(row.declined),
              },
              {
                key: 'in',
                header: COLUMNS.tokensIn,
                numeric: true,
                cell: (row) =>
                  `${formatCount(row.promptTokens)} (${formatCount(row.cachedTokens)})`,
              },
              {
                key: 'out',
                header: COLUMNS.tokensOut,
                numeric: true,
                cell: (row) => formatCount(row.completionTokens),
              },
              {
                key: 'cost',
                header: COLUMNS.cost,
                numeric: true,
                cell: (row) => usdFromMicro(row.costMicro),
              },
            ]}
          />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {SPEND_ESTIMATE_NOTE}
        {spend.since ? ` Counted since ${formatWatDate(spend.since)}.` : ''}
      </p>
    </div>
  )
}

function Impact({ report }: { report: AiReport }) {
  const usage = (feature: string): AiFeatureRow | undefined =>
    report.spend?.features.find((row) => row.feature === feature)
  const hidden = report.spend === null
  const finder = outcomes(usage('name_finder'))
  const help = outcomes(usage('help_answer'))
  const copilot = outcomes(usage('portfolio_copilot'))
  const { lines, delegation, screening, bulk } = report
  return (
    <Panel labelledBy="ai-impact-heading">
      <h2 id="ai-impact-heading" className={PANEL_HEADING}>
        {IMPACT_HEADING}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{IMPACT_INTRO}</p>
      <div className="mt-4 grid gap-6 lg:grid-cols-3">
        <Phase title={PHASES.one}>
          <Measure label={MEASURE.finderLines}>
            {shareWords(lines.nameFinder, lines.paid, 'paid new domains')}
          </Measure>
          <Measure label={MEASURE.pointed}>
            {pointedWords(delegation.verifiedIn7, delegation.registered)}
          </Measure>
          <Measure label={MEASURE.finderCalls}>
            {hidden ? SPEND_HIDDEN : callsWords(finder.calls, finder.failed)}
          </Measure>
          <Measure label={MEASURE.searchConversion}>{NOT_MEASURED.searchConversion}</Measure>
        </Phase>
        <Phase title={PHASES.two}>
          <Measure label={MEASURE.help}>
            {hidden ? SPEND_HIDDEN : helpWords(help.answered, help.declined, help.failed)}
          </Measure>
          <Measure label={MEASURE.screening}>
            {screeningWords(screening.screened, screening.flagged, screening.waiting)}{' '}
            <Link
              href="/admin/screening"
              className={cn('font-medium text-foreground underline underline-offset-4', FOCUS)}
            >
              Open name checks
            </Link>
          </Measure>
          <Measure label={MEASURE.supportEmails}>{NOT_MEASURED.supportEmails}</Measure>
        </Phase>
        <Phase title={PHASES.three}>
          <Measure label={MEASURE.bulk}>
            {bulkWords(bulk.current, bulk.prior, bulk.agencies)}
          </Measure>
          <Measure label={MEASURE.copilot}>
            {hidden
              ? SPEND_HIDDEN
              : copilotWords(copilot.answered, copilot.declined, copilot.failed)}
          </Measure>
          <Measure label={MEASURE.assistantLines}>
            {shareWords(lines.assistantLink, lines.paid, 'paid new domains')}
          </Measure>
        </Phase>
      </div>
    </Panel>
  )
}

function Phase({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <dl className="mt-3 space-y-3">{children}</dl>
    </section>
  )
}

function Measure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-pretty text-foreground">{children}</dd>
    </div>
  )
}
