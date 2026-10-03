import { Plus } from 'lucide-react'
import Link from 'next/link'
import { Suspense } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FOCUS, PANEL_HEADING, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { formatCount, formatWat } from '@/features/admin/lib/format'
import { SETTINGS_PAGES } from '@/features/admin/lib/settings-copy'
import {
  NEW_PRESET,
  PRESET_STATUS_LABEL,
  PRESET_STATUSES,
  PRESETS_BASE,
  type PresetStatus,
  parsePresetStatus,
  presetsHref,
} from '@/features/admin/lib/settings-params'
import {
  type DraftRow,
  draftCheckWords,
  isFailing,
  type PresetRow,
  verifiedWords,
} from '@/features/admin/lib/settings-presets'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { getPresetUsage, listDrafts, listPresets } from '@/features/admin/queries/settings'
import { cn } from '@/lib/utils'
import {
  hiddenWords,
  Nameservers,
  PresetHealth,
  SourceLink,
  usageHeader,
  usageWords,
} from './preset-parts'
import { SettingsHeader } from './settings-header'

export type PresetsPageSearch = Record<string, string | string[] | undefined>

/**
 * `/admin/settings/presets` (docs/ADMIN-SPEC.md §5.2 B13, D21): every host's
 * preset — its nameservers, source, verification, health in public DNS, who
 * hid it — with how many domains, orders and lines use it on this side
 * (`admin_preset_usage`) and its open draft. `?status=draft` (the overview's
 * link) shows only the presets with an open draft, and drafts for new hosts.
 */
export async function PresetsView({ searchParams }: { searchParams: Promise<PresetsPageSearch> }) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  const status = parsePresetStatus(search)
  return (
    <PanelPage>
      <SettingsHeader
        title={SETTINGS_PAGES.presets.title}
        description={SETTINGS_PAGES.presets.description}
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<TableSkeleton rows={6} />}>
        <PresetList admin={admin} side={side} status={status} />
      </Suspense>
    </PanelPage>
  )
}

const linkClass = cn(
  'inline-flex min-h-11 items-center rounded font-medium underline underline-offset-2',
  FOCUS,
)

function draftCell(draft: DraftRow | undefined) {
  if (!draft) return '—'
  const check = draftCheckWords(draft)
  return (
    <span className="flex flex-col items-start gap-1">
      <AdminStatusPill
        value={check.tone === 'ok' ? 'checked' : check.tone === 'warning' ? 'failing' : 'unchecked'}
        tone={check.tone}
        labels={{ checked: 'Draft passed', failing: 'Draft failing', unchecked: 'Draft open' }}
      />
      <span className="block text-xs text-muted-foreground">
        Saved {formatWat(draft.savedAt)} by {draft.savedBy}
      </span>
    </span>
  )
}

export async function PresetList({
  admin,
  side,
  status,
}: {
  admin: AdminPrincipal
  side: AdminSide
  status: PresetStatus | null
}) {
  const [presets, drafts, usage] = await Promise.all([
    listPresets(admin, side),
    listDrafts(admin, side, { open: true }),
    getPresetUsage(side),
  ])
  if (!presets || !drafts) return <ErrorState title="The presets couldn't be loaded." />
  const now = new Date()
  const draftOf = new Map(
    drafts.filter((draft) => draft.presetId).map((draft) => [draft.presetId as string, draft]),
  )
  const newHosts = drafts.filter((draft) => draft.presetId === null)
  const counts: Record<PresetStatus, number> = {
    draft: draftOf.size + newHosts.length,
    hidden: presets.filter((preset) => preset.isHidden).length,
    failing: presets.filter(isFailing).length,
  }
  const shown = presets.filter((preset) => {
    if (status === 'draft') return draftOf.has(preset.id)
    if (status === 'hidden') return preset.isHidden
    if (status === 'failing') return isFailing(preset)
    return true
  })

  const columns: Column<PresetRow>[] = [
    {
      key: 'provider',
      header: 'Provider',
      cell: (row) => (
        <Link href={`${PRESETS_BASE}/${row.id}`} className={linkClass}>
          {row.provider}
        </Link>
      ),
    },
    {
      key: 'nameservers',
      header: 'Nameservers',
      cell: (row) => <Nameservers hosts={row.nameservers} perZone={row.assignsPerZone} />,
    },
    {
      key: 'perzone',
      header: 'Per-zone',
      cell: (row) => (row.assignsPerZone ? 'Yes' : 'No'),
    },
    { key: 'source', header: 'Source', cell: (row) => <SourceLink url={row.sourceUrl} /> },
    {
      key: 'verified',
      header: 'Verified',
      cell: (row) => <span>{verifiedWords(row.verifiedAt, now)}</span>,
    },
    { key: 'health', header: 'Health', cell: (row) => <PresetHealth preset={row} /> },
    { key: 'hidden', header: 'Hidden', cell: hiddenWords },
    {
      key: 'usage',
      header: usageHeader(side),
      cell: (row) => (
        <span data-usage={row.id}>
          {usage === null ? 'Could not be read' : usageWords(usage.get(row.id))}
        </span>
      ),
    },
    {
      key: 'draft',
      header: 'Open draft',
      cell: (row) => <span data-draft={row.id}>{draftCell(draftOf.get(row.id))}</span>,
    },
  ]

  return (
    <div className="space-y-6">
      <section aria-labelledby="settings-presets-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <h2 id="settings-presets-heading" className={PANEL_HEADING}>
            {status ? PRESET_STATUS_LABEL[status] : 'All presets'} · {formatCount(shown.length)}
          </h2>
          <Link href={`${PRESETS_BASE}/${NEW_PRESET}`} className={QUIET_BUTTON}>
            <Plus className="size-4" aria-hidden="true" />
            Add a host
          </Link>
        </div>
        <FilterChips
          label="Preset state"
          chips={PRESET_STATUSES.map((value) => ({
            value,
            label: PRESET_STATUS_LABEL[value],
            count: counts[value],
          }))}
          selected={status ? [status] : []}
          href={(value) => presetsHref(status === value ? null : (value as PresetStatus))}
          allHref={PRESETS_BASE}
        />
        <DataTable
          caption={`Nameserver presets, ${side === 'test' ? 'Test' : 'Live'} side usage`}
          rows={shown}
          columns={columns}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title={
                status === 'draft'
                  ? 'No preset has an open draft.'
                  : status
                    ? `No preset is ${PRESET_STATUS_LABEL[status].toLowerCase()}.`
                    : 'No presets yet.'
              }
              action={
                status ? (
                  <Link href={PRESETS_BASE} className={QUIET_BUTTON}>
                    Show every preset
                  </Link>
                ) : undefined
              }
            />
          }
        />
      </section>

      {status === null || status === 'draft' ? (
        <section aria-labelledby="settings-new-hosts-heading" className="space-y-3">
          <h2 id="settings-new-hosts-heading" className={cn(PANEL_HEADING, 'px-1')}>
            Drafts for new hosts · {formatCount(newHosts.length)}
          </h2>
          {newHosts.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              None open. A new host starts as a draft from “Add a host”.
            </p>
          ) : (
            <ul className="space-y-2">
              {newHosts.map((draft) => (
                <li
                  key={draft.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border bg-card/80 px-4 py-2"
                >
                  <Link href={`${PRESETS_BASE}/${draft.id}`} className={linkClass}>
                    {draft.provider}
                  </Link>
                  {draftCell(draft)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}
