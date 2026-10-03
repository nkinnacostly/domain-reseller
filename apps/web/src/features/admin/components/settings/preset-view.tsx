import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Suspense } from 'react'
import { FOCUS, PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { ErrorState } from '@/features/admin/components/error-state'
import { canAct } from '@/features/admin/lib/actions'
import { formatCount, formatWat } from '@/features/admin/lib/format'
import { OWNER_ONLY, PRESET_COPY, SIDE_NAME } from '@/features/admin/lib/settings-copy'
import { NEW_PRESET, PRESETS_BASE, presetRouteId } from '@/features/admin/lib/settings-params'
import {
  canPublish,
  type DraftRow,
  draftCheckWords,
  isOpen,
  type PresetRow,
  verifiedWords,
} from '@/features/admin/lib/settings-presets'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { getDraft, getPreset, getPresetUsage, listDrafts } from '@/features/admin/queries/settings'
import { cn } from '@/lib/utils'
import { DraftForm } from './draft-form'
import { DraftActions, VisibilityActions } from './preset-actions'
import { hiddenWords, Nameservers, PresetHealth, SourceLink, usageWords } from './preset-parts'
import { RoleNote, SettingsHeader } from './settings-header'

const PRESETS_CRUMB = [{ label: 'Nameserver presets', href: PRESETS_BASE }]

const linkClass = cn(
  'inline-flex min-h-11 items-center rounded font-medium underline underline-offset-2',
  FOCUS,
)

/**
 * `/admin/settings/presets/[id]` (docs/ADMIN-SPEC.md §5.2 B13, D21): one
 * preset — its nameservers, source, checks, who uses it — with Hide or Show
 * again, and its draft: Check now, Publish, Discard, or a form to save one.
 * The same route shows a new host's draft by the draft's id, and `new` is
 * the form for a new host. A registrar default is read-only.
 */
export async function PresetPageView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const [side, { id: raw }] = await Promise.all([getAdminSide(admin), params])
  const id = presetRouteId(raw)
  if (!id) notFound()
  if (id === NEW_PRESET) return <NewPresetView admin={admin} side={side} />

  const preset = await getPreset(admin, side, id)
  if (preset === 'error') return <LoadFailed admin={admin} side={side} />
  if (preset) return <PresetDetail admin={admin} side={side} preset={preset} />

  const draft = await getDraft(admin, side, id)
  if (draft === 'error') return <LoadFailed admin={admin} side={side} />
  if (!draft) notFound()
  // An open change to a preset lives on the preset's own page.
  if (draft.presetId !== null && isOpen(draft)) redirect(`${PRESETS_BASE}/${draft.presetId}`)
  return <NewHostDraftView admin={admin} side={side} draft={draft} />
}

function LoadFailed({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  return (
    <PanelPage>
      <SettingsHeader
        title="Nameserver preset"
        description="One host's nameservers, their checks and their draft."
        side={side}
        testOnly={admin.testOnly}
        crumbs={PRESETS_CRUMB}
      />
      <ErrorState title="This preset couldn't be loaded." />
    </PanelPage>
  )
}

export async function PresetDetail({
  admin,
  side,
  preset,
}: {
  admin: AdminPrincipal
  side: AdminSide
  preset: PresetRow
}) {
  const returnTo = `${PRESETS_BASE}/${preset.id}`
  const isDefault = preset.registrarDefaultFor !== null
  return (
    <PanelPage>
      <SettingsHeader
        title={preset.provider}
        titleAside={<PresetHealth preset={preset} />}
        description={
          isDefault
            ? `The registrar's own default nameservers on the ${preset.registrarDefaultFor === 'sandbox' ? 'sandbox' : 'live'} side.`
            : "A host's nameservers as customers pick them at checkout, on the Nameservers tab and in bulk changes."
        }
        side={side}
        testOnly={admin.testOnly}
        crumbs={PRESETS_CRUMB}
      />
      <Panel labelledBy="preset-facts-heading">
        <h2 id="preset-facts-heading" className={PANEL_HEADING}>
          This preset
        </h2>
        <Suspense
          fallback={
            <div aria-hidden="true" className="mt-4 h-40 animate-pulse rounded-2xl bg-muted/60" />
          }
        >
          <PresetFacts preset={preset} side={side} />
        </Suspense>
      </Panel>

      {isDefault ? (
        <Panel labelledBy="preset-default-heading">
          <h2 id="preset-default-heading" className={PANEL_HEADING}>
            Changes
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-foreground">{PRESET_COPY.registrarDefault}</p>
        </Panel>
      ) : (
        <>
          <Panel labelledBy="preset-visibility-heading">
            <h2 id="preset-visibility-heading" className={PANEL_HEADING}>
              Shown to customers
            </h2>
            <Suspense
              fallback={
                <div
                  aria-hidden="true"
                  className="mt-4 h-11 w-48 animate-pulse rounded-full bg-muted/60"
                />
              }
            >
              <Visibility admin={admin} side={side} preset={preset} returnTo={returnTo} />
            </Suspense>
          </Panel>
          <Suspense
            fallback={
              <div aria-hidden="true" className="h-72 animate-pulse rounded-3xl bg-muted/60" />
            }
          >
            <PresetDrafts admin={admin} side={side} preset={preset} returnTo={returnTo} />
          </Suspense>
        </>
      )}
    </PanelPage>
  )
}

export async function PresetFacts({ preset, side }: { preset: PresetRow; side: AdminSide }) {
  const usage = await getPresetUsage(side)
  const now = new Date()
  const hosts = preset.lastCheck?.hosts ?? []
  return (
    <DlGrid
      className="mt-4"
      items={[
        {
          label: 'Nameservers',
          value: <Nameservers hosts={preset.nameservers} perZone={preset.assignsPerZone} />,
        },
        { label: 'Source', value: <SourceLink url={preset.sourceUrl} /> },
        { label: 'Verified', value: verifiedWords(preset.verifiedAt, now) },
        {
          label: 'Last checked in public DNS',
          value: preset.assignsPerZone ? (
            PRESET_COPY.perZone
          ) : preset.lastCheckedAt ? (
            <span>
              {formatWat(preset.lastCheckedAt)}
              {hosts.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-sm">
                  {hosts.map((host) => (
                    <li key={host.host} className="break-all">
                      <span className="font-mono">{host.host}</span>:{' '}
                      {host.verdict === 'resolves'
                        ? 'answers'
                        : host.verdict === 'fails'
                          ? "doesn't resolve"
                          : 'no answer'}
                    </li>
                  ))}
                </ul>
              ) : null}
            </span>
          ) : (
            'Not checked yet'
          ),
        },
        {
          label: 'Failing since',
          value: preset.checkFailedSince ? formatWat(preset.checkFailedSince) : '—',
        },
        { label: 'Hidden', value: hiddenWords(preset) },
        {
          label: `In use (${SIDE_NAME[side]} side)`,
          value: usage === null ? 'Could not be read' : usageWords(usage.get(preset.id)),
        },
        { label: 'Notes', value: preset.notes ?? '—', wide: true },
      ]}
    />
  )
}

async function Visibility({
  admin,
  side,
  preset,
  returnTo,
}: {
  admin: AdminPrincipal
  side: AdminSide
  preset: PresetRow
  returnTo: string
}) {
  const usage = await getPresetUsage(side)
  const domains = usage === null ? null : (usage.get(preset.id)?.domains ?? 0)
  const action = preset.isHidden ? 'preset.show' : 'preset.hide'
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-foreground">
        {preset.isHidden
          ? `Hidden ${preset.autoHiddenAt ? 'by the health check' : 'by a person'}: customers don't see it as a choice.`
          : 'Shown: customers can choose it.'}
      </p>
      {preset.autoHiddenAt ? (
        <p className="max-w-2xl text-sm text-muted-foreground">{PRESET_COPY.checkerHid}</p>
      ) : (
        <>
          <RoleNote words={canAct(admin, action) ? null : OWNER_ONLY.presets} />
          <VisibilityActions
            preset={{ id: preset.id, provider: preset.provider, isHidden: preset.isHidden }}
            domains={domains}
            side={side}
            returnTo={returnTo}
          />
        </>
      )}
    </div>
  )
}

/** The open draft and what to do with it, or the form to save one; earlier drafts below. */
async function PresetDrafts({
  admin,
  side,
  preset,
  returnTo,
}: {
  admin: AdminPrincipal
  side: AdminSide
  preset: PresetRow
  returnTo: string
}) {
  const drafts = await listDrafts(admin, side, { presetId: preset.id })
  if (!drafts) return <ErrorState title="This preset's drafts couldn't be loaded." />
  const open = drafts.find(isOpen)
  const past = drafts.filter((draft) => !isOpen(draft))
  return (
    <Panel labelledBy="preset-draft-heading">
      <h2 id="preset-draft-heading" className={PANEL_HEADING}>
        {open ? 'Open draft' : 'Change the nameservers'}
      </h2>
      <div className="mt-3 space-y-4">
        <RoleNote words={canAct(admin, 'preset.draft_save') ? null : OWNER_ONLY.presets} />
        {open ? (
          <DraftSummary draft={open} before={preset} returnTo={returnTo} />
        ) : (
          <DraftForm
            start={{
              presetId: preset.id,
              provider: preset.provider,
              nameservers: preset.nameservers,
              sourceUrl: preset.sourceUrl,
              notes: preset.notes,
              assignsPerZone: preset.assignsPerZone,
            }}
            returnTo={returnTo}
          />
        )}
        {past.length > 0 ? (
          <details className="rounded-2xl border border-border px-4 py-1">
            <summary
              className={cn(
                'cursor-pointer rounded py-3 text-sm font-medium text-foreground',
                FOCUS,
              )}
            >
              Earlier drafts · {formatCount(past.length)}
            </summary>
            <ul className="mt-1 mb-3 space-y-3 text-sm">
              {past.map((draft) => (
                <li key={draft.id} className="break-words">
                  <span className="font-medium">
                    {draft.publishedAt
                      ? `Published ${formatWat(draft.publishedAt)}`
                      : `Discarded ${formatWat(draft.discardedAt)}`}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    · saved by {draft.savedBy} {formatWat(draft.savedAt)} ·{' '}
                    {draft.assignsPerZone ? 'per domain' : draft.nameservers.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  )
}

/** A draft beside what is live now, its check, and its buttons while it is open. */
export function DraftSummary({
  draft,
  before,
  returnTo,
}: {
  draft: DraftRow
  before: PresetRow | null
  returnTo: string
}) {
  const check = draftCheckWords(draft)
  return (
    <div className="space-y-4" data-draft-id={draft.id}>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-sm text-muted-foreground">Now</dt>
          <dd className="mt-1">
            {before ? (
              <Nameservers hosts={before.nameservers} perZone={before.assignsPerZone} />
            ) : draft.presetId ? (
              <Link href={`${PRESETS_BASE}/${draft.presetId}`} className={linkClass}>
                On the preset's page
              </Link>
            ) : (
              'Not offered yet'
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-sm text-muted-foreground">Draft</dt>
          <dd className="mt-1">
            <Nameservers hosts={draft.nameservers} perZone={draft.assignsPerZone} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-sm text-muted-foreground">Source</dt>
          <dd className="mt-1">
            <SourceLink url={draft.sourceUrl} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-sm text-muted-foreground">Saved</dt>
          <dd className="mt-1 text-foreground">
            {formatWat(draft.savedAt)} by {draft.savedBy}
          </dd>
        </div>
        {draft.notes ? (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-sm text-muted-foreground">Notes</dt>
            <dd className="mt-1 break-words text-foreground">{draft.notes}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2" data-draft-check>
        <AdminStatusPill
          value={check.tone}
          tone={check.tone}
          labels={{
            ok: 'Check passed',
            warning: 'Check failed',
            info: 'Not checked',
            neutral: 'Nothing to check',
          }}
        />
        <span className="text-sm text-foreground">{check.words}</span>
      </div>
      {isOpen(draft) ? (
        <DraftActions
          draft={{ id: draft.id, provider: draft.provider, nameservers: draft.nameservers }}
          before={before ? before.nameservers : null}
          publishable={canPublish(draft)}
          checkable={!draft.assignsPerZone && draft.nameservers.length > 0}
          lastCheck={check.words}
          returnTo={returnTo}
        />
      ) : null}
    </div>
  )
}

/** `new`: the form for a host we do not offer yet. */
function NewPresetView({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  return (
    <PanelPage>
      <SettingsHeader
        title="Add a host"
        description="A new host starts as a draft: checked in public DNS, then published by the owner."
        side={side}
        testOnly={admin.testOnly}
        crumbs={PRESETS_CRUMB}
      />
      <Panel labelledBy="new-preset-heading">
        <h2 id="new-preset-heading" className={PANEL_HEADING}>
          New preset
        </h2>
        <div className="mt-3 space-y-4">
          <RoleNote words={canAct(admin, 'preset.draft_save') ? null : OWNER_ONLY.presets} />
          <DraftForm
            start={{
              presetId: null,
              provider: '',
              nameservers: [],
              sourceUrl: '',
              notes: null,
              assignsPerZone: false,
            }}
            returnTo={`${PRESETS_BASE}/${NEW_PRESET}`}
          />
        </div>
      </Panel>
    </PanelPage>
  )
}

/** A new host's draft, open or done, by the draft's id. */
function NewHostDraftView({
  admin,
  side,
  draft,
}: {
  admin: AdminPrincipal
  side: AdminSide
  draft: DraftRow
}) {
  const open = isOpen(draft)
  return (
    <PanelPage>
      <SettingsHeader
        title={`${draft.provider}: draft`}
        description={
          draft.presetId === null
            ? 'A host we do not offer yet. Customers see it only once this draft is published.'
            : "A draft of this host's nameservers, kept on record."
        }
        side={side}
        testOnly={admin.testOnly}
        crumbs={PRESETS_CRUMB}
      />
      <Panel labelledBy="new-host-draft-heading">
        <h2 id="new-host-draft-heading" className={PANEL_HEADING}>
          {open ? 'Open draft' : draft.publishedAt ? 'Published' : 'Discarded'}
        </h2>
        <div className="mt-3 space-y-4">
          {draft.publishedAt && draft.presetId ? (
            <p className="text-sm text-foreground">
              Published {formatWat(draft.publishedAt)}.{' '}
              <Link href={`${PRESETS_BASE}/${draft.presetId}`} className={linkClass}>
                Open the {draft.provider} preset
              </Link>
            </p>
          ) : null}
          {draft.discardedAt ? (
            <p className="text-sm text-foreground">Discarded {formatWat(draft.discardedAt)}.</p>
          ) : null}
          {open ? (
            <RoleNote words={canAct(admin, 'preset.publish') ? null : OWNER_ONLY.presets} />
          ) : null}
          <DraftSummary draft={draft} before={null} returnTo={`${PRESETS_BASE}/${draft.id}`} />
        </div>
      </Panel>
    </PanelPage>
  )
}
