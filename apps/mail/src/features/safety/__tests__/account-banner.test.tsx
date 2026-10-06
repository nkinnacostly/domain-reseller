import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getUsage } from '@/features/accounts/queries/overview'
import { getCapNotice } from '../queries/cap-notices'

/**
 * The dashboard banner with the cap notice in it (MAIL-SPEC §8): read on its
 * own, after the account's usage gives this Lagos day and month.
 */

vi.mock('@/features/accounts/queries/overview', () => ({ getUsage: vi.fn() }))
vi.mock('../queries/cap-notices', () => ({ getCapNotice: vi.fn() }))

const { AccountBannerWithCaps, BannerSlot } = await import('../components/account-banner')

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const usage = {
  day: '2026-10-06',
  monthStart: '2026-10-01',
  planCode: 'free',
  caps: { daily: 100, monthly: 3000 },
  today: { queued: 85, sent: 85, delivered: 80, bounced: 0, complained: 0, failed: 0 },
  month: { queued: 85, sent: 85, delivered: 80, bounced: 0, complained: 0, failed: 0 },
}

beforeEach(() => vi.clearAllMocks())

describe('AccountBannerWithCaps', () => {
  it('puts this day’s cap notice in the banner, asking for this day and month', async () => {
    vi.mocked(getUsage).mockResolvedValue(usage)
    vi.mocked(getCapNotice).mockResolvedValue({ scope: 'day', level: 80, cap: 100, used: 85 })
    render(
      await AccountBannerWithCaps({
        account: { id: ACCOUNT, state: 'active', sesStatus: 'enabled' },
        billing: null,
        sandboxCap: null,
      }),
    )
    expect(getCapNotice).toHaveBeenCalledWith(ACCOUNT, usage)
    expect(screen.getByRole('region', { name: 'Account status' })).toHaveTextContent(
      '80% of the cap for today is used',
    )
  })

  it('shows the banner without a notice when usage cannot be read, and nothing when there is nothing to say', async () => {
    vi.mocked(getUsage).mockResolvedValue(null)
    const { container } = render(
      await AccountBannerWithCaps({
        account: { id: ACCOUNT, state: 'active', sesStatus: 'enabled' },
        billing: null,
        sandboxCap: null,
      }),
    )
    expect(getCapNotice).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
    render(
      await AccountBannerWithCaps({
        account: { id: ACCOUNT, state: 'sandbox', sesStatus: 'enabled' },
        billing: null,
        sandboxCap: 100,
      }),
    )
    expect(screen.getByRole('region', { name: 'Account status' })).toHaveTextContent('sandbox')
    expect(render(<BannerSlot banner={null} />).container).toBeEmptyDOMElement()
  })

  it('shows a past-due plan from billing, with the link to Billing, over a cap notice', async () => {
    vi.mocked(getUsage).mockResolvedValue(usage)
    vi.mocked(getCapNotice).mockResolvedValue({ scope: 'day', level: 80, cap: 100, used: 85 })
    render(
      await AccountBannerWithCaps({
        account: { id: ACCOUNT, state: 'active', sesStatus: 'enabled' },
        billing: {
          status: 'past_due',
          until: new Date('2026-11-01T00:00:00Z'),
          reason: 'renewal_failed',
          planName: 'Starter',
        },
        sandboxCap: null,
      }),
    )
    const region = screen.getByRole('region', { name: 'Account status' })
    expect(region).not.toHaveTextContent('80% of the cap')
    expect(screen.getByRole('link', { name: 'Go to Billing' })).toHaveAttribute(
      'href',
      '/dashboard/billing',
    )
  })
})
