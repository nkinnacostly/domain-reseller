import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { canAct } from '@/features/admin/lib/actions'
import {
  LIMITS_COPY,
  LIMITS_HIDDEN,
  LIMITS_UNREADABLE,
  OWNER_ONLY,
  SETTINGS_PAGES,
} from '@/features/admin/lib/settings-copy'
import {
  LIMIT_FIELDS,
  LIMIT_GROUPS,
  type Limits,
  limitWords,
} from '@/features/admin/lib/settings-limits'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { getLimits } from '@/features/admin/queries/settings'
import { LimitsForm } from './limits-form'
import { RoleNote, SettingsHeader } from './settings-header'

/**
 * `/admin/settings` — the limits (docs/ADMIN-SPEC.md §5.2 B13): the 11
 * numbers in `ops_settings` the site works by. The owner changes them in a
 * form; anyone else reads them. A test administrator is shown none: the row
 * has no side and holds the money limits.
 */
export async function LimitsView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <SettingsHeader
        title={SETTINGS_PAGES.limits.title}
        description={SETTINGS_PAGES.limits.description}
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<LimitsSkeleton />}>
        <LimitsPanel admin={admin} side={side} />
      </Suspense>
    </PanelPage>
  )
}

export function LimitsSkeleton() {
  return <div aria-hidden="true" className="h-[36rem] animate-pulse rounded-3xl bg-muted/60" />
}

export async function LimitsPanel({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const limits = await getLimits(admin, side)
  if (limits === null) return <ErrorState title={LIMITS_UNREADABLE} />
  return (
    <Panel labelledBy="settings-limits-heading">
      <h2 id="settings-limits-heading" className={PANEL_HEADING}>
        Limits
      </h2>
      {limits === 'hidden' ? (
        <p className="mt-2 text-sm text-muted-foreground">{LIMITS_HIDDEN}</p>
      ) : (
        <>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{LIMITS_COPY.intro}</p>
          {canAct(admin, 'settings.update') ? (
            <LimitsForm limits={limits} />
          ) : (
            <div className="mt-4 space-y-4">
              <RoleNote words={OWNER_ONLY.limits} />
              <LimitsList limits={limits} />
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

/** The limits read-only, grouped as the form groups them. */
export function LimitsList({ limits }: { limits: Limits }) {
  return (
    <div className="space-y-5">
      {LIMIT_GROUPS.map((group) => (
        <section key={group.id} aria-labelledby={`limits-${group.id}`}>
          <h3 id={`limits-${group.id}`} className="text-sm font-semibold text-foreground">
            {group.title}
          </h3>
          <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {LIMIT_FIELDS.filter((field) => field.group === group.id).map((field) => (
              <div key={field.key} className="min-w-0" data-limit={field.key}>
                <dt className="text-sm text-muted-foreground">{field.label}</dt>
                <dd className="mt-0.5 text-foreground tabular-nums">
                  {limitWords(field, limits[field.key])}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
