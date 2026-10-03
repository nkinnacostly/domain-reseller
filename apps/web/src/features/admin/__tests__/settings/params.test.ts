import { describe, expect, it } from 'vitest'
import {
  extensionName,
  extensionsHref,
  NEW_PRESET,
  parseExtensionsSearch,
  parsePresetStatus,
  presetRouteId,
  presetsHref,
  toggleStatus,
} from '@/features/admin/lib/settings-params'

/**
 * The Settings lists' URLs (docs/ADMIN-SPEC.md §5.2, §9's link contract):
 * strict parsing — an unknown value is the default list — and links built
 * from parsed values only.
 */

describe('the extensions list', () => {
  it('opens on every extension, by name, 50 a page', () => {
    expect(parseExtensionsSearch({})).toMatchObject({
      sort: 'name',
      dir: 'asc',
      page: 1,
      per: 50,
      status: [],
      q: null,
      edit: null,
    })
  })

  it('takes a name, state chips, a sort and an open extension from the URL', () => {
    const params = parseExtensionsSearch({
      q: '.COM',
      status: 'paused,featured,bogus',
      sort: 'rank',
      dir: 'desc',
      page: '2',
      edit: 'Africa',
    })
    expect(params).toMatchObject({
      q: 'com',
      status: ['paused', 'featured'],
      sort: 'rank',
      dir: 'desc',
      page: 2,
      edit: 'africa',
    })
  })

  it('drops a name that is not an extension: no wildcard reaches the query', () => {
    expect(extensionName('co%')).toBeNull()
    expect(extensionName('a_b')).toBeNull()
    expect(extensionName('')).toBeNull()
    expect(extensionName('com.ng')).toBe('com.ng')
    expect(parseExtensionsSearch({ q: ['xyz', 'abc'], sort: 'held' })).toMatchObject({
      q: 'xyz',
      sort: 'name',
    })
  })

  it('builds links that keep the filters, close the open extension and go back to page 1 on a change', () => {
    const params = parseExtensionsSearch({ q: 'com', status: 'paused', page: '3', edit: 'ng' })
    expect(extensionsHref(params)).toBe('/admin/settings/extensions?status=paused&page=3&q=com')
    expect(extensionsHref(params, { edit: 'com.ng' })).toBe(
      '/admin/settings/extensions?status=paused&page=3&q=com&edit=com.ng#change-extension',
    )
    expect(extensionsHref(params, { status: [] })).toBe('/admin/settings/extensions?q=com')
    expect(extensionsHref(params, { q: null })).toBe(
      '/admin/settings/extensions?status=paused&page=3',
    )
    expect(extensionsHref(params, { sort: 'synced', dir: 'desc' })).toBe(
      '/admin/settings/extensions?status=paused&sort=synced&dir=desc&q=com',
    )
  })

  it('toggles one state chip at a time', () => {
    const params = parseExtensionsSearch({ status: 'paused' })
    expect(toggleStatus(params, 'featured')).toEqual(['paused', 'featured'])
    expect(toggleStatus(params, 'paused')).toEqual([])
  })
})

describe('the presets list', () => {
  it("opens with the overview's ?status=draft, and ignores anything else", () => {
    expect(parsePresetStatus({ status: 'draft' })).toBe('draft')
    expect(parsePresetStatus({ status: ['hidden'] })).toBe('hidden')
    expect(parsePresetStatus({ status: 'failing' })).toBe('failing')
    expect(parsePresetStatus({ status: 'nonsense' })).toBeNull()
    expect(parsePresetStatus({})).toBeNull()
    expect(presetsHref('draft')).toBe('/admin/settings/presets?status=draft')
    expect(presetsHref(null)).toBe('/admin/settings/presets')
  })

  it('opens a preset or a draft by uuid, or the form for a new host', () => {
    expect(presetRouteId(NEW_PRESET)).toBe('new')
    expect(presetRouteId('D97320B5-50A9-44D4-A881-7B4BC1A5E077')).toBe(
      'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
    )
    expect(presetRouteId('vercel')).toBeNull()
    expect(presetRouteId('../admins')).toBeNull()
  })
})
