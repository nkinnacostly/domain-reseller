import {
  type ListParams,
  type ListSpec,
  listHref,
  parseListParams,
} from '@/features/admin/lib/list-params'

/**
 * The Settings lists' URLs (docs/ADMIN-SPEC.md §5.2): what the extensions
 * list shows, in what order, and which extension's controls are open; which
 * presets the presets list shows. Parsing is strict — an unknown value falls
 * back to the default list — and links are built from parsed values only.
 */

type Search = Record<string, string | string[] | undefined>

const first = (search: Search, key: string): string | undefined => {
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

// ── Extensions ──────────────────────────────────────────────────────────────

export const EXTENSION_SORTS = ['name', 'rank', 'synced'] as const
export type ExtensionSort = (typeof EXTENSION_SORTS)[number]

export const EXTENSION_STATUSES = ['paused', 'featured', 'unsold', 'country'] as const
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number]

export const EXTENSION_STATUS_LABEL: Record<ExtensionStatus, string> = {
  paused: 'Paused',
  featured: 'Featured',
  unsold: 'Not sold by DomainNameAPI',
  country: 'Country codes',
}

export const EXTENSIONS_SPEC: ListSpec<ExtensionSort, ExtensionStatus> = {
  sorts: EXTENSION_SORTS,
  defaultSort: 'name',
  defaultDir: 'asc',
  statuses: EXTENSION_STATUSES,
  perOptions: [50, 100, 200],
  defaultPer: 50,
}

/** An extension name as typed: lower-case, no leading dot, letters, digits, dots and hyphens. */
const EXTENSION = /^[a-z0-9][a-z0-9.-]{0,62}$/

export function extensionName(value: string | undefined | null): string | null {
  const name = (value ?? '').trim().toLowerCase().replace(/^\.+/, '')
  return EXTENSION.test(name) ? name : null
}

export type ExtensionsSearch = ListParams<ExtensionSort, ExtensionStatus> & {
  /** Extensions whose name starts with this. */
  q: string | null
  /** The extension whose controls are open. */
  edit: string | null
}

export function parseExtensionsSearch(search: Search): ExtensionsSearch {
  return {
    ...parseListParams(search, EXTENSIONS_SPEC),
    q: extensionName(first(search, 'q')),
    edit: extensionName(first(search, 'edit')),
  }
}

export const EXTENSIONS_BASE = '/admin/settings/extensions'

/** The same list with some values changed; the open extension closes unless named. */
export function extensionsHref(
  params: ExtensionsSearch,
  changes: Partial<ListParams<ExtensionSort, ExtensionStatus>> & {
    q?: string | null
    edit?: string | null
  } = {},
): string {
  const { q, edit, ...rest } = changes
  const query = q === undefined ? params.q : q
  const open = edit === undefined ? null : edit
  const href = listHref(EXTENSIONS_BASE, params, EXTENSIONS_SPEC, {
    ...rest,
    extra: { q: query, edit: open },
  })
  return open ? `${href}#change-extension` : href
}

/** Toggling one status chip. */
export function toggleStatus(params: ExtensionsSearch, status: ExtensionStatus): ExtensionStatus[] {
  return params.status.includes(status)
    ? params.status.filter((value) => value !== status)
    : [...params.status, status]
}

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * `?status=draft` — the overview's link (§9 cross-page contract) — shows the
 * presets with an open draft and the drafts for new hosts; `hidden` and
 * `failing` narrow to those. Anything else is the whole list.
 */
export const PRESET_STATUSES = ['draft', 'hidden', 'failing'] as const
export type PresetStatus = (typeof PRESET_STATUSES)[number]

export const PRESET_STATUS_LABEL: Record<PresetStatus, string> = {
  draft: 'Open drafts',
  hidden: 'Hidden',
  failing: 'Failing',
}

export function parsePresetStatus(search: Search): PresetStatus | null {
  const value = first(search, 'status')
  return (PRESET_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as PresetStatus)
    : null
}

export const PRESETS_BASE = '/admin/settings/presets'

export function presetsHref(status: PresetStatus | null): string {
  return status ? `${PRESETS_BASE}?status=${status}` : PRESETS_BASE
}

/** A preset's own page, or a draft for a new host's; `new` is the form for one. */
export const NEW_PRESET = 'new'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function presetRouteId(value: string): string | null {
  if (value === NEW_PRESET) return NEW_PRESET
  return UUID.test(value) ? value.toLowerCase() : null
}
