import Link from 'next/link'
import { Suspense } from 'react'
import { FOCUS, PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import { canAct } from '@/features/admin/lib/actions'
import { formatWat } from '@/features/admin/lib/format'
import {
  buildSteps,
  CHANGED_NOTE,
  catalogueHints,
  exampleLine,
  formatIcannFee,
  formatMargin,
  formatPercent,
  NO_SETTINGS,
  noExampleWords,
  PRICING_DESCRIPTION,
  STATUS_ERROR,
  settingNote,
} from '@/features/admin/lib/pricing-copy'
import type { PricingStatus, RateRow, SampleTld } from '@/features/admin/lib/pricing-data'
import { chargedRate, pricingInputs, termsAt } from '@/features/admin/lib/pricing-rules'
import {
  getCurrentRates,
  getPricingStatus,
  getSampleTld,
  getSettingsChangedAt,
  SAMPLE_TLD,
} from '@/features/admin/queries/pricing'
import { type AdminPrincipal, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { PricingHeader, PricingSectionsSkeleton } from './pricing-header'
import { SettingsForm } from './settings-form'

/**
 * `/admin/pricing` (docs/ADMIN-SPEC.md §5.2 B12): how a price is built, with
 * today's figures and one worked example; the pricing settings in full, VAT
 * read-only; the form that changes the other four (owner, money tier); and
 * what the catalogue holds. Every figure is read from the database (N5b).
 */
export async function PricingView() {
  const admin = await requireAdmin()
  return (
    <PanelPage>
      <PricingHeader title="Pricing" description={PRICING_DESCRIPTION} />
      <Suspense fallback={<PricingSectionsSkeleton cards={3} />}>
        <PricingSections admin={admin} />
      </Suspense>
    </PanelPage>
  )
}

/**
 * The active rate as prices are built from it — its costing rate and the
 * buffer its own row carries — or null with none. There is one active rate
 * at most (a unique index), and its row is read whole, buffer included.
 */
export function activeWithBuffer(
  rows: RateRow[],
): { costingRate: number; bufferPct: number; charged: number } | null {
  const row = rows.find((rate) => rate.status === 'active')
  if (!row) return null
  const rate = { costingRate: row.costingRate, bufferPct: row.bufferPct }
  return { ...rate, charged: chargedRate(rate) }
}

export async function PricingSections({ admin }: { admin: AdminPrincipal }) {
  const [status, rates, sample, changedAt] = await Promise.all([
    getPricingStatus(),
    getCurrentRates(admin),
    getSampleTld(admin),
    getSettingsChangedAt(admin),
  ])
  if (!status || !rates) return <ErrorState title={STATUS_ERROR.title} body={STATUS_ERROR.body} />
  const settings = status.settings
  if (!settings) return <EmptyState title={NO_SETTINGS.title} body={NO_SETTINGS.body} />
  const active = activeWithBuffer(rates)

  return (
    <>
      <Panel labelledBy="pricing-built-heading">
        <h2 id="pricing-built-heading" className={PANEL_HEADING}>
          How a price is built
        </h2>
        <ol className="mt-3 max-w-2xl list-decimal space-y-1.5 pl-5 text-sm/6 text-foreground">
          {buildSteps({ settings, active }).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-4 max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground tabular-nums">
          <Example sample={sample} active={active} settings={settings} />
        </p>
        <p className="mt-3 text-sm">
          <Link
            href="/admin/pricing/fx"
            className={cn(
              'inline-flex min-h-11 items-center rounded text-foreground underline underline-offset-4',
              FOCUS,
            )}
          >
            The active rate and rates held for review
          </Link>
        </p>
      </Panel>

      <Panel labelledBy="pricing-settings-heading">
        <h2 id="pricing-settings-heading" className={PANEL_HEADING}>
          Settings
        </h2>
        <DlGrid
          className="mt-4"
          items={[
            {
              label: 'Margin',
              value: (
                <Setting
                  value={`${formatMargin(settings.marginNgn)} a domain`}
                  note={settingNote('margin_ngn', null)}
                />
              ),
            },
            {
              label: 'FX buffer',
              value: (
                <Setting
                  value={formatPercent(settings.fxBufferPct)}
                  note={settingNote('fx_buffer_pct', active?.bufferPct ?? null)}
                />
              ),
            },
            {
              label: 'ICANN fee',
              value: (
                <Setting
                  value={formatIcannFee(settings.icannFeeCents)}
                  note={settingNote('icann_fee_cents', null)}
                />
              ),
            },
            {
              label: 'Move threshold',
              value: (
                <Setting
                  value={formatPercent(settings.fxMoveThresholdPct)}
                  note={settingNote('fx_move_threshold_pct', null)}
                />
              ),
            },
            {
              label: 'VAT',
              value: (
                <Setting
                  value={formatPercent(settings.vatPct)}
                  note={settingNote('vat_pct', null)}
                />
              ),
            },
            {
              label: 'Last changed',
              value: <Setting value={formatWat(changedAt)} note={CHANGED_NOTE} />,
            },
          ]}
        />
      </Panel>

      <Panel labelledBy="pricing-change-heading">
        <h2 id="pricing-change-heading" className={PANEL_HEADING}>
          Change settings
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-sm text-muted-foreground">
          Saving asks for a reason and the code from your authenticator app, and is recorded in the
          audit log. VAT isn't here: it's changed in the SQL editor.
        </p>
        <SettingsForm
          settings={settings}
          sample={sample}
          active={active ? { costingRate: active.costingRate, bufferPct: active.bufferPct } : null}
          ownerOnly={!canAct(admin, 'pricing.update')}
        />
      </Panel>

      <CatalogueCounts status={status} />
    </>
  )
}

function Setting({ value, note }: { value: string; note: string }) {
  return (
    <>
      <span className="block tabular-nums">{value}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{note}</span>
    </>
  )
}

/** One worked example, first term and renewal (N8), or why there is none. */
export function Example({
  sample,
  active,
  settings,
}: {
  sample: SampleTld | null
  active: { costingRate: number; bufferPct: number } | null
  settings: NonNullable<PricingStatus['settings']>
}) {
  if (!sample) return <>{noExampleWords(SAMPLE_TLD, 'unreadable')}</>
  if (!sample.onSale) return <>{noExampleWords(sample.name, 'not_on_sale')}</>
  const terms = termsAt(sample, pricingInputs(active, settings))
  if (!terms) return <>{noExampleWords(sample.name, 'no_price')}</>
  return <>{exampleLine(sample.name, terms)}</>
}

function CatalogueCounts({ status }: { status: PricingStatus }) {
  const hints = catalogueHints(status)
  return (
    <Panel labelledBy="pricing-catalogue-heading">
      <h2 id="pricing-catalogue-heading" className={PANEL_HEADING}>
        Catalogue
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        What DomainNameAPI&apos;s catalogue holds. Pausing and featuring extensions, and putting SSL
        products on sale, are in Settings.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          label="Extensions in the catalogue"
          value={status.tlds.total.toLocaleString('en-GB')}
          hint={hints.tlds}
          href="/admin/settings/extensions"
        />
        <StatTile
          label="SSL products in the catalogue"
          value={status.ssl.total.toLocaleString('en-GB')}
          hint={hints.ssl}
          href="/admin/settings/ssl-products"
        />
      </div>
      <p className="mt-3 text-sm">
        <Link
          href="/admin/supplier/catalogue"
          className={cn(
            'inline-flex min-h-11 items-center rounded text-foreground underline underline-offset-4',
            FOCUS,
          )}
        >
          When the price list last synced
        </Link>
      </p>
    </Panel>
  )
}
