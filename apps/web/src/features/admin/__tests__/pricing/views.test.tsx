import { render, screen, within } from '@testing-library/react'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FxSections, FxView, heldRates } from '@/features/admin/components/pricing/fx-view'
import {
  PricingHeader,
  PricingPageSkeleton,
} from '@/features/admin/components/pricing/pricing-header'
import {
  activeWithBuffer,
  Example,
  PricingSections,
  PricingView,
} from '@/features/admin/components/pricing/pricing-view'
import * as queries from '@/features/admin/queries/pricing'
import { requireAdmin } from '@/features/admin/queries/session'
import {
  comSample,
  freshRow,
  hoursAgo,
  NOW,
  pending,
  rateRow,
  settings,
  staleRow,
  status,
} from './fixtures'

/**
 * The Pricing & FX pages (docs/ADMIN-SPEC.md §5.2 B12) in every state (S11):
 * an error with a way on, nothing to show, and the page itself — VAT
 * read-only, the example with its renewal (N8), a held rate that is too old
 * offering Reject only, and whatever state the rates are in.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/pricing/fx',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/pricing', () => ({
  updatePricingSettings: vi.fn(),
  activateFxRate: vi.fn(),
  rejectFxRate: vi.fn(),
}))
vi.mock('@/features/admin/queries/session', () => ({ requireAdmin: vi.fn() }))
vi.mock('@/features/admin/queries/pricing', () => ({
  SAMPLE_TLD: 'com',
  getPricingStatus: vi.fn(),
  getCurrentRates: vi.fn(),
  getRecentRates: vi.fn(),
  getSampleTld: vi.fn(),
  getSettingsChangedAt: vi.fn(),
}))

type Admin = { role: 'owner' | 'operator' | 'viewer'; testOnly: boolean; label: string }
const OWNER: Admin = { role: 'owner', testOnly: false, label: 'owner' }
const TEST_OPERATOR: Admin = { role: 'operator', testOnly: true, label: 'e2e-1' }

function as(admin: Admin) {
  vi.mocked(requireAdmin).mockResolvedValue(admin as never)
  return admin as never
}

/** Every element in a tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const props = node.props as { children?: ReactNode }
  return [node, ...elements(props.children)]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(queries.getPricingStatus).mockResolvedValue(status())
  vi.mocked(queries.getCurrentRates).mockResolvedValue([staleRow(), rateRow()])
  vi.mocked(queries.getRecentRates).mockResolvedValue([rateRow(), staleRow()])
  vi.mocked(queries.getSampleTld).mockResolvedValue(comSample())
  vi.mocked(queries.getSettingsChangedAt).mockResolvedValue('2026-09-20T19:44:56.567115+00:00')
})

describe('the header', () => {
  it('names the page, with both pages as tabs and the current one marked (S13)', () => {
    render(<PricingHeader title="Exchange rates" description="d" />)
    const tabs = screen.getByRole('navigation', { name: 'Pricing pages' })
    expect(within(tabs).getByRole('link', { name: 'Exchange rates' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Pricing' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    // Prices are the same on both sides: no Live/Test switch here.
    expect(screen.queryByRole('group', { name: 'Records shown' })).toBeNull()
  })

  it('has a skeleton, not a spinner, while it loads', () => {
    const { container } = render(<PricingPageSkeleton cards={3} />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4)
  })

  it('streams the sections for the admin it asked SQL about', async () => {
    const admin = as(TEST_OPERATOR)
    for (const [view, sections] of [
      [PricingView, PricingSections],
      [FxView, FxSections],
    ] as const) {
      const tree = elements(await view())
      expect(tree.find((element) => element.type === sections)?.props).toMatchObject({ admin })
    }
  })
})

describe('/admin/pricing', () => {
  it('errs with a way on when the status or the rates could not be read', async () => {
    vi.mocked(queries.getPricingStatus).mockResolvedValue(null)
    const { unmount } = render(await PricingSections({ admin: as(OWNER) }))
    expect(screen.getByRole('alert')).toHaveTextContent("Pricing couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    unmount()
    vi.mocked(queries.getPricingStatus).mockResolvedValue(status())
    vi.mocked(queries.getCurrentRates).mockResolvedValue(null)
    render(await PricingSections({ admin: as(OWNER) }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('says there are no settings, rather than inventing them', async () => {
    vi.mocked(queries.getPricingStatus).mockResolvedValue(status({ settings: null }))
    render(await PricingSections({ admin: as(OWNER) }))
    expect(screen.getByText('No pricing settings')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows the settings in full, VAT read-only, the example with its renewal, and the catalogue', async () => {
    render(await PricingSections({ admin: as(OWNER) }))
    const built = screen.getByRole('region', { name: 'How a price is built' })
    expect(within(built).getByText('at the active rate, ₦1,330.57 to the dollar,')).toBeVisible()
    expect(
      within(built).getByText('.com today: ₦19,600 for the first year, then ₦19,900/yr.'),
    ).toBeInTheDocument()

    const stored = screen.getByRole('region', { name: 'Settings' })
    expect(within(stored).getByText('₦4,250 a domain')).toBeInTheDocument()
    expect(within(stored).getByText('7.5%')).toBeInTheDocument()
    expect(
      within(stored).getByText("VAT is a statutory rate; it's changed in the SQL editor."),
    ).toBeInTheDocument()
    expect(
      within(stored).getByText(
        'Added to each rate the FX job fetches. The active rate carries its own: 0%.',
      ),
    ).toBeInTheDocument()
    expect(within(stored).getByText(/^20 Sept? 2026, 20:44 WAT$/)).toBeInTheDocument()
    expect(
      within(stored).getByText('Who changed what, and why, is in the audit log.'),
    ).toBeVisible()

    const change = screen.getByRole('region', { name: 'Change settings' })
    expect(within(change).getAllByRole('textbox')).toHaveLength(4)
    expect(within(change).queryByRole('textbox', { name: /VAT/ })).toBeNull()
    expect(within(change).queryByText('Only the owner can save these settings.')).toBeNull()

    const catalogue = screen.getByRole('region', { name: 'Catalogue' })
    expect(
      within(catalogue).getByRole('link', { name: /Extensions in the catalogue\s+812/ }),
    ).toHaveAttribute('href', '/admin/settings/extensions')
    expect(within(catalogue).getByText('798 sellable, 3 paused by us, 6 featured')).toBeVisible()
  })

  it('tells a test administrator up front that only the owner saves', async () => {
    render(await PricingSections({ admin: as(TEST_OPERATOR) }))
    expect(screen.getByText('Only the owner can save these settings.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
  })

  it('says why there is no example: unreadable, not on sale, or no rate', () => {
    const { rerender } = render(<Example sample={null} active={null} settings={settings()} />)
    expect(
      screen.getByText("No example price: .com's catalogue row couldn't be read."),
    ).toBeVisible()
    rerender(<Example sample={comSample({ onSale: false })} active={null} settings={settings()} />)
    expect(screen.getByText(".com isn't on sale, so there is no example price.")).toBeVisible()
    rerender(<Example sample={comSample()} active={null} settings={settings()} />)
    expect(
      screen.getByText(
        'No example price for .com: the site shows none until there is an active rate.',
      ),
    ).toBeVisible()
  })

  it('takes the active rate and its own buffer from its row', () => {
    expect(activeWithBuffer([staleRow(), rateRow({ bufferPct: 2 })])).toEqual({
      costingRate: 1330.5689,
      bufferPct: 2,
      charged: 1330.5689 * 1.02,
    })
    expect(activeWithBuffer([staleRow()])).toBeNull()
  })
})

describe('/admin/pricing/fx', () => {
  it('shows the active rate, and the stale held rate with Reject only and why', async () => {
    render(await FxSections({ admin: as(OWNER), now: NOW }))
    const active = screen.getByRole('region', { name: 'Active rate' })
    expect(within(active).getByText('₦1,330.57 to the dollar')).toBeVisible()
    expect(within(active).getByText('₦1,330.57 (no buffer)')).toBeVisible()
    expect(within(active).getByText(/cross-checks the market feeds/)).toHaveTextContent(
      'more than 2%. A rate within 6.5% of the active one',
    )

    const held = screen.getByRole('region', { name: 'Held for review (1)' })
    const card = within(held).getByRole('listitem')
    expect(card).toHaveAttribute('data-rate-id', staleRow().id)
    expect(within(card).getByRole('heading', { name: '₦1,700.00 to the dollar' })).toBeVisible()
    expect(within(card).getByText('Too old to activate', { exact: true })).toBeVisible()
    expect(
      within(card).getByText('Too old to activate — the daily job will fetch a fresh one.', {
        exact: false,
      }),
    ).toHaveTextContent('Quoted 48 hours ago or more.')
    // Both moves, and both quote times.
    expect(within(card).getByText('+20.6%')).toBeVisible()
    expect(within(card).getByText('+27.8%')).toBeVisible()
    expect(within(card).getByText('Active rate quoted')).toBeVisible()
    expect(within(card).getByText('₦1,768.00: ₦1,700.00 plus its 4% buffer')).toBeVisible()
    expect(within(card).queryByRole('button', { name: /^Activate/ })).toBeNull()
    expect(within(card).getByRole('button', { name: 'Reject ₦1,700.00' })).toBeEnabled()
    expect(screen.queryByText('Only the owner can activate or reject a rate.')).toBeNull()

    const recent = screen.getByRole('region', { name: 'Recent rates' })
    expect(within(recent).getAllByText('Held for review').length).toBeGreaterThan(0)
  })

  it('offers Activate for a fresh rate newer than the active one', async () => {
    vi.mocked(queries.getCurrentRates).mockResolvedValue([freshRow(), rateRow()])
    vi.mocked(queries.getPricingStatus).mockResolvedValue(
      status({
        fx: { active: status().fx.active, pending: [pending(freshRow())] },
      }),
    )
    render(await FxSections({ admin: as(OWNER), now: NOW }))
    const held = screen.getByRole('list', { name: 'Rates held for review' })
    const card = within(held).getByRole('listitem')
    expect(within(card).getByText('Ready to review')).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Activate ₦1,523.40' })).toBeEnabled()
    expect(within(card).getByRole('button', { name: 'Reject ₦1,523.40' })).toBeEnabled()
  })

  it('tells a test administrator up front that only the owner acts on a rate', async () => {
    render(await FxSections({ admin: as(TEST_OPERATOR), now: NOW }))
    expect(screen.getByText('Only the owner can activate or reject a rate.')).toBeVisible()
  })

  it('says when nothing is held and there is no active rate, in words with the threshold', async () => {
    vi.mocked(queries.getCurrentRates).mockResolvedValue([])
    vi.mocked(queries.getRecentRates).mockResolvedValue([])
    vi.mocked(queries.getPricingStatus).mockResolvedValue(
      status({ fx: { active: null, pending: [] } }),
    )
    render(await FxSections({ admin: as(OWNER), now: NOW }))
    expect(
      screen.getByText('No active rate. The site shows no prices until one is activated.', {
        selector: 'p',
      }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'No rate is held for review. The FX job holds one here when it moves more than 6.5% from the active rate, or when there is no active rate.',
      ),
    ).toBeVisible()
    expect(screen.getByText('No rates yet')).toBeVisible()
  })

  it('errs when the rates could not be read, and when the history could not', async () => {
    vi.mocked(queries.getCurrentRates).mockResolvedValue(null)
    const { unmount } = render(await FxSections({ admin: as(OWNER), now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("Pricing couldn't be loaded.")
    unmount()
    vi.mocked(queries.getCurrentRates).mockResolvedValue([rateRow()])
    vi.mocked(queries.getRecentRates).mockResolvedValue(null)
    render(await FxSections({ admin: as(OWNER), now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("The latest rates couldn't be loaded.")
  })

  it('judges held rates by SQL’s flags and the clock, newest first as read', () => {
    const active = { ...rateRow(), charged: 1330.5689 }
    const held = heldRates(
      [freshRow(), staleRow(), rateRow()],
      [pending(freshRow(), { olderThanActive: true })],
      active,
      NOW,
    )
    expect(held.map((rate) => [rate.row.id, rate.offers.blockedBy])).toEqual([
      [freshRow().id, 'older_than_active'],
      [staleRow().id, 'too_old'],
    ])
    expect(held[1]?.row.charged).toBeCloseTo(1768, 9)
    expect(heldRates([freshRow({ quotedAt: hoursAgo(1) })], [], null, NOW)[0]?.moveNow).toBeNull()
  })
})
