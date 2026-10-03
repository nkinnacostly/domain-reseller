import { Search, X } from 'lucide-react'
import Link from 'next/link'
import { Suspense } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS, PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { canAct } from '@/features/admin/lib/actions'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import {
  EXTENSIONS_COPY,
  OWNER_ONLY,
  SETTINGS_PAGES,
  SIDE_NAME,
} from '@/features/admin/lib/settings-copy'
import {
  EXTENSION_STATUS_LABEL,
  EXTENSION_STATUSES,
  EXTENSIONS_BASE,
  type ExtensionSort,
  type ExtensionStatus,
  type ExtensionsSearch,
  extensionsHref,
  parseExtensionsSearch,
  toggleStatus,
} from '@/features/admin/lib/settings-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  type ExtensionRow,
  getExtension,
  getFeaturedRanks,
  getHeldCounts,
  listExtensions,
} from '@/features/admin/queries/settings'
import { cn } from '@/lib/utils'
import { ExtensionControls } from './extension-controls'
import { RoleNote, SettingsHeader } from './settings-header'

export type ExtensionsPageSearch = Record<string, string | string[] | undefined>

/**
 * `/admin/settings/extensions` (docs/ADMIN-SPEC.md §5.2 B13): every
 * extension in the catalogue, filtered by name and by state in the URL, with
 * the domains held on each on this side (`admin_tld_held_counts`). "Change"
 * opens one extension's Pause, Resume and Feature dialogs above the list.
 */
export async function ExtensionsView({
  searchParams,
}: {
  searchParams: Promise<ExtensionsPageSearch>
}) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  const params = parseExtensionsSearch(search)
  return (
    <PanelPage>
      <SettingsHeader
        title={SETTINGS_PAGES.extensions.title}
        description={SETTINGS_PAGES.extensions.description}
        side={side}
        testOnly={admin.testOnly}
      />
      {params.edit ? (
        <Suspense
          fallback={
            <div aria-hidden="true" className="h-72 animate-pulse rounded-3xl bg-muted/60" />
          }
        >
          <ExtensionPanel admin={admin} side={side} name={params.edit} params={params} />
        </Suspense>
      ) : null}
      <Panel labelledBy="settings-extensions-filter-heading">
        <h2 id="settings-extensions-filter-heading" className="sr-only">
          Find extensions
        </h2>
        <ExtensionFilters params={params} />
      </Panel>
      <Suspense fallback={<TableSkeleton rows={10} />}>
        <ExtensionList admin={admin} side={side} params={params} />
      </Suspense>
    </PanelPage>
  )
}

export function ExtensionFilters({ params }: { params: ExtensionsSearch }) {
  return (
    <div className="space-y-4">
      <search>
        <form
          method="get"
          action={EXTENSIONS_BASE}
          aria-label="Extensions by name"
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="extensions-q" className="text-sm font-medium text-foreground">
              Name starts with
            </label>
            <input
              id="extensions-q"
              type="search"
              name="q"
              defaultValue={params.q ?? ''}
              placeholder="com"
              autoComplete="off"
              spellCheck={false}
              className={cn(inputClass, 'mt-1.5')}
            />
          </div>
          {params.status.length > 0 ? (
            <input type="hidden" name="status" value={params.status.join(',')} />
          ) : null}
          <button type="submit" className={QUIET_BUTTON}>
            <Search className="size-4" aria-hidden="true" />
            Find
          </button>
          {params.q ? (
            <Link href={extensionsHref(params, { q: null })} className={QUIET_BUTTON}>
              <X className="size-4" aria-hidden="true" />
              Clear name
            </Link>
          ) : null}
        </form>
      </search>
      <FilterChips
        label="Extension state"
        chips={EXTENSION_STATUSES.map((status) => ({
          value: status,
          label: EXTENSION_STATUS_LABEL[status],
        }))}
        selected={params.status}
        href={(value) =>
          extensionsHref(params, { status: toggleStatus(params, value as ExtensionStatus) })
        }
        allHref={extensionsHref(params, { status: [] })}
      />
    </div>
  )
}

function stateCell(row: ExtensionRow) {
  return (
    <div className="space-y-1">
      <AdminStatusPill
        value={row.isPaused ? 'paused' : row.isSellable ? 'on_sale' : 'not_sold'}
        tone={row.isPaused ? 'warning' : row.isSellable ? 'ok' : 'neutral'}
        labels={{ paused: 'Paused', on_sale: 'On sale', not_sold: 'Not sold by DomainNameAPI' }}
      />
      {row.isPaused && row.pausedReason ? (
        <p className="max-w-xs text-xs break-words text-muted-foreground">{row.pausedReason}</p>
      ) : null}
    </div>
  )
}

export async function ExtensionList({
  admin,
  side,
  params,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: ExtensionsSearch
}) {
  const [page, held] = await Promise.all([listExtensions(admin, side, params), getHeldCounts(side)])
  if (!page) return <ErrorState title="The extensions couldn't be loaded." />

  const heldOf = (name: string) => (held === null ? '—' : formatCount(held.get(name) ?? 0))
  const columns: Column<ExtensionRow, ExtensionSort>[] = [
    {
      key: 'name',
      header: 'Extension',
      sort: 'name',
      cell: (row) => <span className="font-medium break-all">.{row.name}</span>,
    },
    { key: 'state', header: 'State', cell: stateCell },
    {
      key: 'featured',
      header: 'Featured',
      sort: 'rank',
      cell: (row) =>
        row.featuredRank === null ? (
          '—'
        ) : (
          <span>
            Rank {row.featuredRank}
            {row.featuredTagline ? (
              <span className="block max-w-xs text-xs break-words text-muted-foreground">
                {row.featuredTagline}
              </span>
            ) : null}
          </span>
        ),
    },
    {
      key: 'held',
      header: `Held (${SIDE_NAME[side]})`,
      numeric: true,
      cell: (row) => <span data-held={row.name}>{heldOf(row.name)}</span>,
    },
    {
      key: 'synced',
      header: 'Synced',
      sort: 'synced',
      cell: (row) => <span className="whitespace-nowrap">{formatWatDate(row.syncedAt)}</span>,
    },
    {
      key: 'change',
      header: 'Change',
      cell: (row) => (
        <Link
          href={extensionsHref(params, { edit: row.name })}
          className={cn(
            'inline-flex min-h-11 items-center rounded font-medium underline underline-offset-2',
            FOCUS,
          )}
          aria-label={`${EXTENSIONS_COPY.manage} .${row.name}`}
        >
          {EXTENSIONS_COPY.manage}
        </Link>
      ),
    },
  ]
  const pages = pageCount(page.total, params.per)
  const filtered = params.q !== null || params.status.length > 0

  return (
    <section aria-labelledby="settings-extensions-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 id="settings-extensions-heading" className={PANEL_HEADING}>
          {filtered ? 'Matching extensions' : 'All extensions'} · {formatCount(page.total)}
        </h2>
        <p className="text-xs text-muted-foreground">
          {held === null
            ? 'Held domains could not be read; try again.'
            : EXTENSIONS_COPY.heldNote(side)}
        </p>
      </div>
      <DataTable
        caption={`Extensions, ${SIDE_NAME[side]} side held counts, page ${params.page} of ${pages}`}
        rows={page.rows}
        columns={columns}
        rowKey={(row) => row.name}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => extensionsHref(params, nextSort(params, sort)),
        }}
        empty={
          <EmptyState
            title={page.total > 0 ? 'No extensions on this page.' : 'No extensions match.'}
            body={filtered ? 'Change the name or the state chosen.' : undefined}
            action={
              <Link href={EXTENSIONS_BASE} className={QUIET_BUTTON}>
                Show every extension
              </Link>
            }
          />
        }
      />
      <Pager
        page={params.page}
        pageCount={pages}
        total={page.total}
        href={(target) => extensionsHref(params, { page: target })}
      />
    </section>
  )
}

/** One extension's state and its dialogs, opened from the list (`?edit=`). */
export async function ExtensionPanel({
  admin,
  side,
  name,
  params,
}: {
  admin: AdminPrincipal
  side: AdminSide
  name: string
  params: ExtensionsSearch
}) {
  const [extension, held, ranks] = await Promise.all([
    getExtension(admin, side, name),
    getHeldCounts(side),
    getFeaturedRanks(admin, side),
  ])
  const close = extensionsHref(params)
  if (extension === 'error' || ranks === null) {
    return <ErrorState title={`.${name} couldn't be loaded.`} />
  }
  if (extension === null) {
    return (
      <EmptyState
        title={`There is no .${name} in the catalogue.`}
        action={
          <Link href={close} className={QUIET_BUTTON}>
            {EXTENSIONS_COPY.close}
          </Link>
        }
      />
    )
  }
  const count = held === null ? null : (held.get(extension.name) ?? 0)
  const returnTo = extensionsHref(params, { edit: extension.name }).split('#')[0] ?? EXTENSIONS_BASE
  return (
    <Panel id="change-extension" labelledBy="change-extension-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="change-extension-heading" className="text-xl font-medium text-foreground">
          Change .{extension.name}
        </h2>
        <Link href={close} className={QUIET_BUTTON}>
          <X className="size-4" aria-hidden="true" />
          {EXTENSIONS_COPY.close}
        </Link>
      </div>
      <DlGrid
        className="mt-4"
        items={[
          { label: 'State', value: stateCell(extension) },
          {
            label: 'Featured',
            value:
              extension.featuredRank === null
                ? 'No'
                : `Rank ${extension.featuredRank}${extension.featuredTagline ? ` — ${extension.featuredTagline}` : ''}`,
          },
          {
            label: `Held domains (${SIDE_NAME[side]} side)`,
            value: count === null ? 'Could not be read' : formatCount(count),
          },
        ]}
      />
      {extension.isSellable ? null : (
        <p className="mt-4 max-w-2xl text-sm text-foreground">{EXTENSIONS_COPY.notSold}</p>
      )}
      <div className="mt-5 space-y-4">
        <RoleNote words={canAct(admin, 'extension.flags') ? null : OWNER_ONLY.extensions} />
        <ExtensionControls
          extension={extension}
          held={count}
          side={side}
          ranks={ranks}
          returnTo={returnTo}
        />
      </div>
    </Panel>
  )
}
