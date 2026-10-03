import { cleanup, render, screen, within } from '@testing-library/react'
import { cookies } from 'next/headers'
import { Suspense } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminsView } from '@/features/admin/components/settings/admins-view'
import { ExtensionsView } from '@/features/admin/components/settings/extensions-view'
import { LimitsView } from '@/features/admin/components/settings/limits-view'
import { PresetPageView } from '@/features/admin/components/settings/preset-view'
import { PresetsView } from '@/features/admin/components/settings/presets-view'
import { SslProductsView } from '@/features/admin/components/settings/ssl-products-view'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { draftRecord, fakeService, ids, opsRow, presetRecord, type Read, tldRow } from './fake-db'

/**
 * The Settings pages as rendered (docs/ADMIN-SPEC.md §5.2 B13): each with
 * its loading, empty, error and success states; what the owner, an operator
 * and a test admin each see; and the side's counts.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/admin/settings',
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  },
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/features/admin/actions/settings', () => ({ updateLimits: vi.fn() }))
vi.mock('@/features/admin/actions/extensions', () => ({ setExtensionFlags: vi.fn() }))
vi.mock('@/features/admin/actions/ssl-products', () => ({ setSslSellable: vi.fn() }))
vi.mock('@/features/admin/actions/presets', () => ({
  savePresetDraft: vi.fn(),
  checkPresetDraft: vi.fn(),
  publishPresetDraft: vi.fn(),
  discardPresetDraft: vi.fn(),
  hidePreset: vi.fn(),
  showPreset: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// requireAdmin and the counts are React's cache(): outside a render they would remember one answer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T,>(fn: T) => fn,
}))

type Rpc = NonNullable<Parameters<typeof sessionClient>[0]>['rpc']

function signedIn(rpc: Rpc = {}, who: Record<string, unknown> = {}, side?: 'live' | 'test') {
  vi.mocked(cookies).mockResolvedValue({
    get: () => (side ? { name: 'dr_admin_side', value: side } : undefined),
  } as never)
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role: 'owner', label: 'owner', ...who }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const TEST_ADMIN = { role: 'operator', testOnly: true, label: 'e2e-1a2b3c4d' }
const search = (value: Record<string, string> = {}) => Promise.resolve(value)

/** Renders an async server tree, resolving each nested async component as React would. */
async function serverRender(node: Promise<React.ReactElement>) {
  return render(await resolveTree(await node))
}

async function resolveTree(node: unknown): Promise<React.ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree))
  if (!node || typeof node !== 'object' || !('type' in node)) return node as React.ReactNode
  const element = node as React.ReactElement<{ children?: unknown; fallback?: unknown }>
  // Suspense: render what it waits for, not its fallback.
  if (element.type === Suspense) {
    return resolveTree(element.props.children)
  }
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolveTree(await (element.type as (props: unknown) => Promise<unknown>)(element.props))
  }
  const children = element.props?.children
  if (children === undefined) return element
  return { ...element, props: { ...element.props, children: await resolveTree(children) } } as never
}

beforeEach(() => vi.clearAllMocks())

describe('the limits page', () => {
  it('gives the owner the form, grouped, with each limit and its bounds', async () => {
    fakeService(() => ({ data: opsRow() }))
    signedIn()
    await serverRender(LimitsView())
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Settings pages' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Limits', 'Extensions', 'SSL products', 'Presets', 'Admins'])
    const form = screen.getByRole('form', { name: 'Limits' })
    for (const legend of ['Refunds', 'Orders', 'Velocity', 'Float']) {
      expect(within(form).getByRole('group', { name: legend })).toBeInTheDocument()
    }
    expect(within(form).getByLabelText('Largest refund sent without a person')).toHaveValue(
      '312500.50',
    )
    expect(within(form).getByLabelText('Alert when the supplier balance is below')).toHaveValue(
      '43.21',
    )
    expect(within(form).getByText(/Up to ₦1,000,000\.$/)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Review changes' })).toBeDisabled()
  })

  it('shows an operator the limits read-only, and says who changes them', async () => {
    fakeService(() => ({ data: opsRow() }))
    signedIn({}, { role: 'operator', label: 'ops' })
    await serverRender(LimitsView())
    const region = screen.getByRole('region', { name: 'Limits' })
    expect(region).toHaveTextContent('Only the owner changes limits.')
    expect(within(region).queryByRole('form')).toBeNull()
    expect(region.querySelector('[data-limit="auto_refund_max_kobo"]')).toHaveTextContent(
      '₦312,500.50',
    )
    expect(region.querySelector('[data-limit="float_alert_cents"]')).toHaveTextContent('$43.21')
  })

  it('shows a test admin no limits at all, and reads none', async () => {
    const reads = fakeService(() => ({ data: opsRow() }))
    signedIn({}, TEST_ADMIN)
    await serverRender(LimitsView())
    expect(screen.getByRole('region', { name: 'Limits' })).toHaveTextContent(
      'Limits are not shown to test administrators.',
    )
    expect(reads).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says when the limits could not be read, with a way to try again', async () => {
    fakeService(() => ({ error: { message: 'timeout' } }))
    signedIn()
    await serverRender(LimitsView())
    expect(screen.getByRole('alert')).toHaveTextContent("The limits couldn't be read.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

const tlds = (read: Read) => {
  if (read.select === 'name, featured_rank') {
    return {
      data: [
        { name: 'com', featured_rank: 1 },
        { name: 'africa', featured_rank: 4 },
      ],
    }
  }
  if (read.filters.some(([method, column]) => method === 'eq' && column === 'name')) {
    return {
      data: tldRow({
        name: 'ng',
        is_paused: true,
        paused_reason: 'Waiting for a source',
        featured_rank: null,
        featured_tagline: null,
      }),
    }
  }
  return {
    data: [
      tldRow(),
      tldRow({
        name: 'ng',
        is_paused: true,
        paused_reason: 'Waiting for a source',
        featured_rank: null,
        featured_tagline: null,
        is_country_code: true,
      }),
      tldRow({ name: 'gone', is_sellable: false, featured_rank: null, featured_tagline: null }),
    ],
    count: 3,
  }
}

describe('the extensions page', () => {
  it('lists extensions with their state, featuring and the held count on the side', async () => {
    fakeService(tlds)
    const session = signedIn({ admin_tld_held_counts: { data: [{ tld: 'africa', held: 12 }] } })
    await serverRender(ExtensionsView({ searchParams: search() }))
    expect(screen.getByRole('heading', { level: 1, name: 'Extensions' })).toBeInTheDocument()
    expect(session.rpc).toHaveBeenCalledWith('admin_tld_held_counts', { p_test_mode: false })
    const list = screen.getByRole('region', { name: 'All extensions · 3' })
    const table = within(list).getByRole('table', {
      name: 'Extensions, Live side held counts, page 1 of 1',
    })
    expect(within(table).getByText('Held (Live)')).toBeInTheDocument()
    expect(table.querySelector('[data-held="africa"]')).toHaveTextContent('12')
    expect(table.querySelector('[data-held="ng"]')).toHaveTextContent('0')
    expect(within(table).getAllByText('Paused').length).toBeGreaterThan(0)
    expect(within(table).getByText('Waiting for a source')).toBeInTheDocument()
    expect(within(table).getByText('Not sold by DomainNameAPI')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Change .ng' })).toHaveAttribute(
      'href',
      '/admin/settings/extensions?edit=ng#change-extension',
    )
    expect(screen.getByRole('searchbox', { name: 'Name starts with' })).toHaveValue('')
    expect(
      within(screen.getByRole('navigation', { name: 'Extension state' })).getByRole('link', {
        name: 'Paused',
      }),
    ).toHaveAttribute('href', '/admin/settings/extensions?status=paused')
  })

  it("opens one extension's controls, with the held count and a note for anyone but the owner", async () => {
    fakeService(tlds)
    signedIn({ admin_tld_held_counts: { data: [{ tld: 'ng', held: 2 }] } }, TEST_ADMIN)
    await serverRender(ExtensionsView({ searchParams: search({ q: 'n', edit: 'ng' }) }))
    const panel = screen.getByRole('region', { name: 'Change .ng' })
    expect(panel).toHaveTextContent('Held domains (Test side)2')
    expect(panel).toHaveTextContent('Only the owner pauses, resumes or features an extension.')
    expect(within(panel).getByRole('button', { name: 'Resume .ng' })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Close' })).toHaveAttribute(
      'href',
      '/admin/settings/extensions?q=n',
    )
  })

  it('says when there is no such extension, and when nothing matches', async () => {
    fakeService((read) =>
      read.filters.some(([method]) => method === 'eq')
        ? { data: null }
        : read.select === 'name, featured_rank'
          ? { data: [] }
          : { data: [], count: 0 },
    )
    signedIn({ admin_tld_held_counts: { data: [] } })
    await serverRender(ExtensionsView({ searchParams: search({ q: 'zz', edit: 'zz' }) }))
    expect(screen.getByText('There is no .zz in the catalogue.')).toBeInTheDocument()
    expect(screen.getByText('No extensions match.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every extension' })).toHaveAttribute(
      'href',
      '/admin/settings/extensions',
    )
  })

  it('keeps the list when the held counts fail, and shows an error when the list does', async () => {
    fakeService(tlds)
    signedIn({ admin_tld_held_counts: { error: { message: 'boom' } } })
    await serverRender(ExtensionsView({ searchParams: search() }))
    expect(screen.getByText('Held domains could not be read; try again.')).toBeInTheDocument()

    fakeService(() => ({ error: { message: 'boom' } }))
    signedIn({ admin_tld_held_counts: { data: [] } })
    await serverRender(ExtensionsView({ searchParams: search({ edit: 'ng' }) }))
    expect(screen.getByText("The extensions couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByText(".ng couldn't be loaded.")).toBeInTheDocument()
  })
})

describe('the SSL products page', () => {
  it('lists products, on sale first, with a dialog for each and no button without a price', async () => {
    fakeService((read) =>
      read.select === 'product_code'
        ? { data: [{ product_code: '999' }] }
        : {
            data: [
              {
                product_code: '351',
                name: 'Sectigo PositiveSSL',
                vendor: 'Sectigo',
                validation_type: 'dv',
                is_sellable: true,
                is_multi_domain: true,
                max_names: 100,
              },
              {
                product_code: '999',
                name: 'Unpriced SSL',
                vendor: null,
                validation_type: null,
                is_sellable: false,
                is_wildcard: true,
              },
            ],
          },
    )
    signedIn({}, { role: 'viewer', label: 'viewer' })
    await serverRender(SslProductsView())
    const region = screen.getByRole('region', { name: 'Products · 2, 1 on sale' })
    expect(region).toHaveTextContent('Only the owner puts a product on sale or takes it off.')
    const table = within(region).getByRole('table', { name: 'SSL products' })
    expect(within(table).getByText('DV · up to 100 names')).toBeInTheDocument()
    expect(within(table).getByText('wildcard')).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: 'Take off sale Sectigo PositiveSSL' }),
    ).toBeInTheDocument()
    expect(
      within(table).getByText('DomainNameAPI lists no price for this product yet.'),
    ).toBeInTheDocument()
  })

  it('says when there are none, and when they could not be read', async () => {
    fakeService(() => ({ data: [] }))
    signedIn()
    await serverRender(SslProductsView())
    expect(screen.getByText('No SSL products yet.')).toBeInTheDocument()
    fakeService(() => ({ error: { message: 'boom' } }))
    signedIn()
    await serverRender(SslProductsView())
    expect(screen.getByText("The SSL products couldn't be loaded.")).toBeInTheDocument()
  })
})

const presetsDb = (read: Read) => {
  if (read.table === 'nameserver_presets') {
    return {
      data: [
        presetRecord(),
        presetRecord({
          id: ids.other,
          provider: 'Zone Host',
          nameservers: [],
          assigns_per_zone: true,
          is_hidden: true,
          last_checked_at: null,
          last_check: null,
        }),
      ],
    }
  }
  return {
    data: [
      draftRecord(),
      draftRecord({
        id: ids.newDraft,
        preset_id: null,
        provider: 'New Host',
        check_ok: true,
        checked_at: '2026-10-03T12:30:00Z',
      }),
    ],
  }
}

describe('the presets page', () => {
  it('lists every preset with who uses it on the side, its health and its open draft', async () => {
    fakeService(presetsDb)
    const session = signedIn({
      admin_preset_usage: { data: [{ preset_id: ids.preset, domains: 3, orders: 1, lines: 2 }] },
    })
    await serverRender(PresetsView({ searchParams: search() }))
    expect(session.rpc).toHaveBeenCalledWith('admin_preset_usage', { p_test_mode: false })
    const region = screen.getByRole('region', { name: 'All presets · 2' })
    const table = within(region).getByRole('table')
    expect(table.querySelector(`[data-usage="${ids.preset}"]`)).toHaveTextContent(
      '3 domains · 1 order · 2 lines',
    )
    expect(table.querySelector(`[data-usage="${ids.other}"]`)).toHaveTextContent('—')
    expect(table.querySelector(`[data-draft="${ids.preset}"]`)).toHaveTextContent('Draft open')
    expect(within(table).getByText('Answers in public DNS')).toBeInTheDocument()
    expect(within(table).getByText('Hidden by a person')).toBeInTheDocument()
    expect(within(table).getByText('Per domain')).toBeInTheDocument()
    const chips = screen.getByRole('navigation', { name: 'Preset state' })
    expect(within(chips).getByRole('link', { name: 'Open drafts (2)' })).toHaveAttribute(
      'href',
      '/admin/settings/presets?status=draft',
    )
    const hosts = screen.getByRole('region', { name: 'Drafts for new hosts · 1' })
    expect(within(hosts).getByRole('link', { name: 'New Host' })).toHaveAttribute(
      'href',
      `/admin/settings/presets/${ids.newDraft}`,
    )
    expect(within(hosts).getByText('Draft passed')).toBeInTheDocument()
  })

  it("opens on the overview's ?status=draft, and on hidden and failing", async () => {
    fakeService(presetsDb)
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetsView({ searchParams: search({ status: 'draft' }) }))
    expect(screen.getByRole('region', { name: 'Open drafts · 1' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Preset state' })).getByRole('link', {
        name: 'Open drafts (2)',
      }),
    ).toHaveAttribute('aria-current', 'true')

    cleanup()
    fakeService(presetsDb)
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetsView({ searchParams: search({ status: 'failing' }) }))
    expect(screen.getByText('No preset is failing.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /Drafts for new hosts/ })).toBeNull()

    cleanup()
    fakeService(presetsDb)
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetsView({ searchParams: search({ status: 'hidden' }) }))
    expect(screen.getByRole('region', { name: 'Hidden · 1' })).toBeInTheDocument()
  })

  it('says when the usage or the presets could not be read', async () => {
    fakeService(presetsDb)
    signedIn({ admin_preset_usage: { error: { message: 'boom' } } })
    await serverRender(PresetsView({ searchParams: search() }))
    expect(screen.getAllByText('Could not be read').length).toBeGreaterThan(0)

    fakeService(() => ({ error: { message: 'boom' } }))
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetsView({ searchParams: search() }))
    expect(screen.getByText("The presets couldn't be loaded.")).toBeInTheDocument()

    fakeService((read) => (read.table === 'nameserver_presets' ? { data: [] } : { data: [] }))
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetsView({ searchParams: search() }))
    expect(screen.getByText('No presets yet.')).toBeInTheDocument()
  })
})

const params = (id: string) => Promise.resolve({ id })

describe("a preset's page", () => {
  it('shows the facts, who uses it, Hide, and the open draft with its buttons', async () => {
    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? { data: presetRecord() }
        : {
            data: [
              draftRecord(),
              draftRecord({ id: ids.newDraft, published_at: '2026-09-30T10:00:00Z' }),
            ],
          },
    )
    signedIn({
      admin_preset_usage: { data: [{ preset_id: ids.preset, domains: 1, orders: 0, lines: 0 }] },
    })
    await serverRender(PresetPageView({ params: params(ids.preset) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Example Host' })).toBeInTheDocument()
    const facts = screen.getByRole('region', { name: 'This preset' })
    expect(facts).toHaveTextContent('In use (Live side)1 domain · 0 orders · 0 lines')
    expect(facts).toHaveTextContent('ns1.example-host.test: answers')
    expect(screen.getByRole('button', { name: 'Hide Example Host' })).toBeInTheDocument()
    const draft = screen.getByRole('region', { name: 'Open draft' })
    expect(draft).toHaveTextContent('ns3.example-host.test')
    expect(draft).toHaveTextContent('Not checked yet.')
    expect(within(draft).getByRole('button', { name: 'Check now' })).toBeInTheDocument()
    expect(
      within(draft).getByRole('button', { name: "Publish Example Host's draft" }),
    ).toBeDisabled()
    expect(within(draft).getByText(/Earlier drafts · 1/)).toBeInTheDocument()
  })

  it('offers the draft form when no draft is open, and Show again when hidden', async () => {
    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? { data: presetRecord({ is_hidden: true }) }
        : { data: [] },
    )
    signedIn({ admin_preset_usage: { data: [] } }, { role: 'operator', label: 'ops' })
    await serverRender(PresetPageView({ params: params(ids.preset) }))
    expect(screen.getByRole('region', { name: 'Change the nameservers' })).toHaveTextContent(
      'Only the owner saves, publishes or shows a preset again',
    )
    expect(screen.getByLabelText('Nameservers')).toHaveValue(
      'ns1.example-host.test\nns2.example-host.test',
    )
    expect(screen.getByRole('button', { name: 'Show Example Host again' })).toBeInTheDocument()
  })

  it('keeps a registrar default read-only, and says the checker hid one', async () => {
    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? { data: presetRecord({ registrar_default_for: 'live' }) }
        : { data: [] },
    )
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetPageView({ params: params(ids.preset) }))
    expect(screen.getByText(/changed in the SQL editor only/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Hide/ })).toBeNull()

    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? {
            data: presetRecord({
              is_hidden: true,
              auto_hidden_at: '2026-10-02T00:00:00Z',
              check_failed_since: '2026-10-01T00:00:00Z',
            }),
          }
        : { data: [] },
    )
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetPageView({ params: params(ids.preset) }))
    expect(screen.getByText(/The health check hid this preset/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show .* again/ })).toBeNull()
  })

  it("shows a new host's draft by its id, and the form for a new host", async () => {
    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? { data: null }
        : { data: draftRecord({ id: ids.newDraft, preset_id: null, provider: 'New Host' }) },
    )
    signedIn({ admin_preset_usage: { data: [] } })
    await serverRender(PresetPageView({ params: params(ids.newDraft) }))
    expect(screen.getByRole('heading', { level: 1, name: 'New Host: draft' })).toBeInTheDocument()
    expect(screen.getByText('Not offered yet')).toBeInTheDocument()

    fakeService(() => ({}))
    signedIn()
    await serverRender(PresetPageView({ params: params('new') }))
    expect(screen.getByRole('heading', { level: 1, name: 'Add a host' })).toBeInTheDocument()
    expect(screen.getByLabelText('Provider')).toHaveValue('')
  })

  it('sends an open draft of a preset to the preset, and a published one links there', async () => {
    fakeService((read) =>
      read.table === 'nameserver_presets' ? { data: null } : { data: draftRecord() },
    )
    signedIn()
    await expect(PresetPageView({ params: params(ids.draft) })).rejects.toThrow(
      `NEXT_REDIRECT /admin/settings/presets/${ids.preset}`,
    )

    fakeService((read) =>
      read.table === 'nameserver_presets'
        ? { data: null }
        : { data: draftRecord({ published_at: '2026-10-03T13:00:00Z' }) },
    )
    signedIn()
    await serverRender(PresetPageView({ params: params(ids.draft) }))
    expect(screen.getByRole('link', { name: 'Open the Example Host preset' })).toHaveAttribute(
      'href',
      `/admin/settings/presets/${ids.preset}`,
    )
  })

  it('is not found for a bad id or nothing by that id, and says when it could not load', async () => {
    signedIn()
    await expect(PresetPageView({ params: params('vercel') })).rejects.toThrow('NEXT_NOT_FOUND')
    fakeService(() => ({ data: null }))
    await expect(PresetPageView({ params: params(ids.preset) })).rejects.toThrow('NEXT_NOT_FOUND')
    fakeService(() => ({ error: { message: 'boom' } }))
    await serverRender(PresetPageView({ params: params(ids.preset) }))
    expect(screen.getByText("This preset couldn't be loaded.")).toBeInTheDocument()
  })
})

describe('the admins page', () => {
  it('shows a test admin only its own row, with its device and the SQL editor note', async () => {
    signedIn(
      {
        admin_list_admins: {
          data: [
            {
              label: 'e2e-1a2b3c4d',
              role: 'operator',
              test_only: true,
              added_at: '2026-10-03T12:00:00Z',
              revoked_at: null,
              pinned_factors: 1,
              verified_pinned_factors: 1,
              last_change_at: '2026-10-03T12:00:00Z',
            },
          ],
        },
      },
      TEST_ADMIN,
    )
    await serverRender(AdminsView())
    const region = screen.getByRole('region', { name: 'Admins · 1' })
    expect(region).toHaveTextContent(
      'Admins and their linked devices are changed in the SQL editor (DEPLOY.md §6b). Every change sends a Telegram alert. A test administrator sees only their own row.',
    )
    const table = within(region).getByRole('table', { name: 'Admins' })
    expect(within(table).getByText('(you)')).toBeInTheDocument()
    expect(table.querySelector('[data-devices="e2e-1a2b3c4d"]')).toHaveTextContent(
      '1 linked, 1 active',
    )
    expect(within(table).getByText('Test')).toBeInTheDocument()
  })

  it('shows a removed device, a revoked admin, and an error', async () => {
    signedIn({
      admin_list_admins: {
        data: [
          {
            label: 'owner',
            role: 'owner',
            test_only: false,
            added_at: '2026-10-01T12:00:00Z',
            revoked_at: null,
            pinned_factors: 2,
            verified_pinned_factors: 1,
            last_change_at: null,
          },
          {
            label: 'old',
            role: 'viewer',
            test_only: false,
            added_at: '2026-09-01T12:00:00Z',
            revoked_at: '2026-09-20T12:00:00Z',
            pinned_factors: 1,
            verified_pinned_factors: 0,
            last_change_at: '2026-09-20T12:00:00Z',
          },
        ],
      },
    })
    await serverRender(AdminsView())
    const table = screen.getByRole('table', { name: 'Admins' })
    expect(within(table).getByText('1 of 2 removed')).toBeInTheDocument()
    expect(within(table).getByText('20 Sept 2026')).toBeInTheDocument()
    expect(within(table).getByText('Viewer')).toBeInTheDocument()

    signedIn({ admin_list_admins: { error: { message: 'boom' } } })
    await serverRender(AdminsView())
    expect(screen.getByText("The admins couldn't be loaded.")).toBeInTheDocument()
  })
})
