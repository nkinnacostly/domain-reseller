import { formatNaira } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AttentionTiles } from '../components/dashboard/attention-tiles'
import { ComingUp, type RecentOrder } from '../components/dashboard/coming-up'
import { AutoRenewGauge } from '../components/dashboard/gauge'
import { NameserverBars } from '../components/dashboard/nameserver-bars'
import { Overview } from '../components/dashboard/overview'
import { RenewalsChart } from '../components/dashboard/renewals-chart'
import { summarize } from '../lib/dashboard'
import type { PortfolioDomain } from '../lib/portfolio'
import type { RecentEvent } from '../queries/domains'

/**
 * Every figure on the dashboard is the one summarize() counts from the
 * account's own rows (FR-P1, N9b), so the fixtures below go through the real
 * summarize() and the assertions read the numbers back from its result.
 */

// 24 Sept 2026, 10:00 in Lagos (UTC+1).
const NOW = new Date('2026-09-24T09:00:00Z')
const DAY = 86_400_000
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY + 3_600_000).toISOString()

function domain(name: string, overrides: Partial<PortfolioDomain> = {}): PortfolioDomain {
  return {
    id: name,
    domainName: name,
    tld: 'com',
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: inDays(200),
    autoRenew: true,
    privacyEnabled: false,
    delegationStatus: 'verified',
    nameservers: null,
    pendingNameservers: null,
    ...overrides,
  }
}

function order(id: string, overrides: Partial<RecentOrder> = {}): RecentOrder {
  return {
    id,
    order_number: `DR-${id}`,
    status: 'completed',
    total_kobo: 2_150_000,
    test_mode: false,
    created_at: '2026-09-20T12:00:00.000Z',
    order_items: [{ domain: 'later.com' }],
    ...overrides,
  }
}

const PORTFOLIO = [
  domain('later.com'),
  domain('soon.com', { expiresAt: inDays(5), autoRenew: false, delegationStatus: 'undelegated' }),
  domain('month.com', { expiresAt: inDays(20), delegationStatus: 'pending' }),
  domain('gone.com', {
    status: 'expired_grace',
    expiresAt: inDays(-6),
    autoRenew: false,
    delegationStatus: 'failed',
  }),
  domain('waiting.com', { status: 'pending', expiresAt: null, delegationStatus: 'undelegated' }),
  domain('failed.com', { status: 'registration_failed', expiresAt: null }),
]

const ORDERS = [
  order('1004', {
    status: 'awaiting_payment',
    total_kobo: '4300000',
    test_mode: true,
    order_items: [{ domain: 'soon.com' }, { domain: 'month.com' }],
  }),
  order('1003', { status: 'paid', order_items: [] }),
  order('1002', { status: 'awaiting_payment' }),
  order('1001'),
]

const EVENTS: RecentEvent[] = [
  {
    id: 12,
    type: 'nameservers_applied',
    payload: { nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] },
    createdAt: '2026-09-23T10:00:00.000Z',
    domainName: 'later.com',
  },
  {
    id: 11,
    type: 'auto_renew_off',
    payload: {},
    createdAt: '2026-09-22T10:00:00.000Z',
    domainName: 'soon.com',
  },
  {
    id: 10,
    type: 'order_paid',
    payload: { order_number: 'DR-1001' },
    createdAt: '2026-09-20T12:05:00.000Z',
    domainName: 'later.com',
  },
  {
    id: 9,
    type: 'registered',
    payload: {},
    createdAt: '2026-09-20T12:10:00.000Z',
    domainName: 'later.com',
  },
]

const summary = summarize(PORTFOLIO, ORDERS, NOW)
const empty = summarize([], [], NOW)

describe('Overview (FR-P1)', () => {
  it('greets the person by the clock in Lagos and says what day it is', () => {
    render(<Overview firstName="Ada" summary={summary} orderCount={ORDERS.length} now={NOW} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Good morning, Ada' })).toBeInTheDocument()
    expect(screen.getByText('It’s Thursday 24 September 2026')).toBeInTheDocument()
  })

  it('greets without a name when the account has none', () => {
    render(<Overview firstName={null} summary={summary} orderCount={0} now={NOW} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Good morning' })).toBeInTheDocument()
  })

  it('shows the portfolio in the four numbers summarize() counted', () => {
    render(<Overview firstName="Ada" summary={summary} orderCount={ORDERS.length} now={NOW} />)

    const terms = screen.getAllByRole('term').map((term) => term.textContent)
    const values = screen.getAllByRole('definition').map((value) => value.textContent)
    expect(Object.fromEntries(terms.map((term, index) => [term, values[index]]))).toEqual({
      Domains: String(summary.total),
      Active: String(summary.active),
      'Due within 30 days': String(summary.dueWithin30),
      Orders: String(ORDERS.length),
    })
  })

  it('shows the share of held domains that renew by themselves', () => {
    render(<Overview firstName="Ada" summary={summary} orderCount={ORDERS.length} now={NOW} />)
    // Four held, two of them renewing by hand.
    expect(summary).toMatchObject({ held: 4, autoRenewOff: 2, autoRenewShare: 50 })
    expect(
      screen.getByRole('img', { name: 'Auto-renew is on for 50% of your domains (2 of 4)' }),
    ).toBeInTheDocument()
  })

  it('links to the renewal dates and to registering another domain', () => {
    render(<Overview firstName="Ada" summary={summary} orderCount={ORDERS.length} now={NOW} />)
    expect(screen.getByRole('link', { name: 'Renewal dates' })).toHaveAttribute(
      'href',
      '/app/domains/expiring',
    )
    expect(screen.getByRole('link', { name: 'Register a new domain' })).toHaveAttribute(
      'href',
      '/search',
    )
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(within(crumbs).getByText('Dashboard')).toHaveAttribute('aria-current', 'page')
  })

  it('shows zeros and no share for a new account', () => {
    render(<Overview firstName="Ada" summary={empty} orderCount={0} now={NOW} />)
    expect(screen.getAllByRole('definition').map((value) => value.textContent)).toEqual([
      '0',
      '0',
      '0',
      '0',
    ])
    expect(
      screen.getByRole('img', { name: 'Auto-renew: no domains to renew yet' }),
    ).toBeInTheDocument()
  })
})

describe('AutoRenewGauge', () => {
  it('reads the share out in words and in figures', () => {
    render(<AutoRenewGauge share={100} on={3} held={3} />)
    const gauge = screen.getByRole('img', {
      name: 'Auto-renew is on for 100% of your domains (3 of 3)',
    })
    expect(gauge).toHaveTextContent('100%')
    expect(gauge).toHaveTextContent('Renew automatically')
  })

  it('shows 0%, not a blank, when nothing renews automatically', () => {
    render(<AutoRenewGauge share={0} on={0} held={2} />)
    const gauge = screen.getByRole('img', {
      name: 'Auto-renew is on for 0% of your domains (0 of 2)',
    })
    expect(gauge).toHaveTextContent('0%')
  })

  it('says there is nothing to renew rather than showing a percentage', () => {
    render(<AutoRenewGauge share={null} on={0} held={0} />)
    const gauge = screen.getByRole('img', { name: 'Auto-renew: no domains to renew yet' })
    expect(gauge).toHaveTextContent('—')
    expect(gauge).toHaveTextContent('Nothing to renew yet')
    expect(gauge).not.toHaveTextContent('%')
  })
})

/**
 * A tile's link reads "View" plus its sr-only detail. jsdom's name
 * computation trims the detail's leading space, where a browser keeps it, so
 * the space between the two is allowed to be missing here.
 */
const tileLink = (action: string, detail: string) =>
  screen.getByRole('link', { name: new RegExp(`^${action}\\s*${detail}$`) })

describe('AttentionTiles', () => {
  /** A tile is found by its label; its value and link are read from inside it. */
  function tile(label: string) {
    const item = screen.getByText(label).closest('li')
    if (!item) throw new Error(`No tile for ${label}`)
    return item
  }

  it('counts each thing that may need doing, from the summary', () => {
    render(<AttentionTiles summary={summary} twoFactorOn={false} />)

    expect(screen.getByRole('region', { name: 'Things to check' })).toBeInTheDocument()
    expect(tile('Due this week')).toHaveTextContent(`${summary.dueWithin7} domains`)
    expect(tile('Auto-renew off')).toHaveTextContent(`${summary.autoRenewOff} domains`)
    expect(tile('Nameservers')).toHaveTextContent(`${summary.nameservers.notSet} not set`)
    expect(tile('Awaiting payment')).toHaveTextContent(`${summary.awaitingPayment} orders`)
    expect(tile('Two-factor sign-in')).toHaveTextContent('Off')
  })

  it('makes each tile one tap from being done, named for screen readers', () => {
    render(<AttentionTiles summary={summary} twoFactorOn={false} />)

    expect(tileLink('View', 'domains due this week')).toHaveAttribute(
      'href',
      '/app/domains?within=7#portfolio',
    )
    expect(tileLink('Review', 'domains that renew by hand')).toHaveAttribute(
      'href',
      '/app/domains#portfolio',
    )
    expect(tileLink('Set up', 'nameservers')).toHaveAttribute(
      'href',
      `/app/domains/${summary.firstNotPointed}/nameservers`,
    )
    expect(tileLink('View', 'orders awaiting payment')).toHaveAttribute('href', '/app/orders')
    expect(tileLink('Turn on', 'two-factor sign-in')).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
  })

  it('goes straight to the first domain not pointed at a host', () => {
    render(<AttentionTiles summary={summary} twoFactorOn />)
    expect(summary.firstNotPointed).toBe('gone.com')
    expect(tileLink('Set up', 'nameservers')).toHaveAttribute(
      'href',
      '/app/domains/gone.com/nameservers',
    )
  })

  it('reads as all clear on a tidy account, and offers to manage two-factor', () => {
    const tidy = summarize([domain('later.com')], [], NOW)
    render(<AttentionTiles summary={tidy} twoFactorOn />)

    expect(tile('Due this week')).toHaveTextContent('0 domains')
    expect(tile('Auto-renew off')).toHaveTextContent('0 domains')
    expect(tile('Nameservers')).toHaveTextContent('0 not set')
    expect(tile('Awaiting payment')).toHaveTextContent('0 orders')
    expect(tile('Two-factor sign-in')).toHaveTextContent('On')
    expect(tileLink('Manage', 'two-factor sign-in')).toBeInTheDocument()
    expect(tileLink('Set up', 'nameservers')).toHaveAttribute('href', '/app/domains#portfolio')
  })

  it('counts one of a thing in the singular', () => {
    const one = summarize(
      [domain('soon.com', { expiresAt: inDays(3), autoRenew: false })],
      [{ status: 'awaiting_payment' }],
      NOW,
    )
    render(<AttentionTiles summary={one} twoFactorOn />)
    expect(tile('Due this week')).toHaveTextContent('1 domain')
    expect(tile('Due this week')).not.toHaveTextContent('1 domains')
    expect(tile('Awaiting payment')).toHaveTextContent('1 order')
    expect(tile('Awaiting payment')).not.toHaveTextContent('1 orders')
  })
})

describe('NameserverBars (FR-D5)', () => {
  function bars() {
    const region = screen.getByRole('region', { name: 'Nameservers' })
    return within(region)
      .getAllByRole('listitem')
      .map((bar) => bar.textContent)
  }

  it('splits the held domains by where they point, as shares and counts', () => {
    render(<NameserverBars nameservers={summary.nameservers} held={summary.held} />)
    const { working, waiting, notSet } = summary.nameservers
    const share = (count: number) => Math.round((count / summary.held) * 100)

    expect(screen.getByRole('region', { name: 'Nameservers' })).toHaveTextContent(
      `${summary.held}domains held`,
    )
    expect(bars()).toEqual([
      `${share(working)}%Working: ${working} domain`,
      `${share(waiting)}%Waiting: ${waiting} domain`,
      `${share(notSet)}%Not set: ${notSet} domains`,
    ])
    expect(bars()).toEqual([
      '25%Working: 1 domain',
      '25%Waiting: 1 domain',
      '50%Not set: 2 domains',
    ])
  })

  it('draws an empty bar as 0%, not as a missing one', () => {
    const one = summarize([domain('later.com')], [], NOW)
    render(<NameserverBars nameservers={one.nameservers} held={one.held} />)

    expect(screen.getByRole('region', { name: 'Nameservers' })).toHaveTextContent('1domain held')
    expect(bars()).toEqual([
      '100%Working: 1 domain',
      '0%Waiting: 0 domains',
      '0%Not set: 0 domains',
    ])
  })

  it('explains what it will show before any domain is registered', () => {
    render(<NameserverBars nameservers={empty.nameservers} held={empty.held} />)
    const region = screen.getByRole('region', { name: 'Nameservers' })
    expect(region).toHaveTextContent('0domains held')
    expect(region).toHaveTextContent(
      'Once a domain is registered, this shows whether it points at your host.',
    )
    expect(within(region).queryByRole('list')).not.toBeInTheDocument()
  })
})

describe('RenewalsChart (FR-P5)', () => {
  it('gives the six-month total and, in words, each month’s count', () => {
    render(<RenewalsChart months={summary.renewalsByMonth} total={summary.renewalsAhead} />)

    const region = screen.getByRole('region', { name: 'Renewals in the next six months' })
    expect(within(region).getByText(String(summary.renewalsAhead))).toBeInTheDocument()
    const months = within(region).getAllByRole('listitem')
    expect(months).toHaveLength(6)
    summary.renewalsByMonth.forEach((month, index) => {
      const noun = month.count === 1 ? 'renewal' : 'renewals'
      expect(months[index]).toHaveTextContent(`${month.label}: ${month.count} ${noun}`)
    })
    expect(months[0]).toHaveTextContent('Sept: 2 renewals')
    expect(months[1]).toHaveTextContent('Oct: 1 renewal')
    expect(region).not.toHaveTextContent('Nothing is due')
  })

  it('links to the 90-day expiry view', () => {
    render(<RenewalsChart months={summary.renewalsByMonth} total={summary.renewalsAhead} />)
    expect(screen.getByRole('link', { name: 'Renewals in the next 90 days' })).toHaveAttribute(
      'href',
      '/app/domains?within=90#portfolio',
    )
  })

  it('says nothing is due when the next six months are clear', () => {
    render(<RenewalsChart months={empty.renewalsByMonth} total={empty.renewalsAhead} />)
    expect(
      screen.getByText('Nothing is due for renewal in the next six months.'),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Sept: 0 renewals')
  })

  it('still draws with no months to plot', () => {
    render(<RenewalsChart months={[]} total={0} />)
    expect(screen.getByRole('region', { name: 'Renewals in the next six months' })).toBeVisible()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})

describe('ComingUp', () => {
  const renderFull = () =>
    render(<ComingUp upcoming={summary.upcoming} orders={ORDERS} events={EVENTS} now={NOW} />)

  function items() {
    return within(screen.getByRole('tabpanel')).getAllByRole('listitem')
  }

  it('dates itself and links to every order', () => {
    renderFull()
    const region = screen.getByRole('region', { name: 'Coming up' })
    const today = region.querySelector('time')
    expect(today).toHaveAttribute('dateTime', NOW.toISOString())
    expect(today).toHaveTextContent('24 Sept 2026')
    expect(within(region).getByRole('link', { name: 'All orders' })).toHaveAttribute(
      'href',
      '/app/orders',
    )
  })

  it('opens on the three soonest renewals summarize() found', () => {
    renderFull()

    expect(screen.getByRole('tab', { name: 'Renewals' })).toHaveAttribute('aria-selected', 'true')
    const panel = screen.getByRole('tabpanel', { name: 'Renewals' })
    const links = within(panel).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(
      summary.upcoming.slice(0, 3).map((row) => `Open ${row.domainName}`),
    )
    expect(within(panel).getByRole('link', { name: 'Open gone.com' })).toHaveAttribute(
      'href',
      '/app/domains/gone.com',
    )
    expect(within(panel).queryByRole('link', { name: 'Open later.com' })).not.toBeInTheDocument()
  })

  it('says, for each renewal, when it falls and whether it renews by itself', () => {
    renderFull()
    const [gone, , month] = items()

    expect(gone).toHaveTextContent('gone.com')
    expect(gone).toHaveTextContent('Auto-renew is off: renew it by hand before it lapses')
    expect(gone).toHaveTextContent('18 Sept 2026')
    expect(gone).toHaveTextContent('6 days ago')
    expect(month).toHaveTextContent('Auto-renew is on')
    expect(month).toHaveTextContent('14 Oct 2026')
    expect(month).toHaveTextContent('in 20 days')
  })

  it('shows the three latest orders, with status, total and date', async () => {
    const user = userEvent.setup()
    renderFull()

    await user.click(screen.getByRole('tab', { name: 'Orders' }))

    const panel = screen.getByRole('tabpanel', { name: 'Orders' })
    expect(items()).toHaveLength(3)
    const [test, noDomains] = items()
    expect(test).toHaveTextContent('Order DR-1004 (test)')
    expect(test).toHaveTextContent('soon.com, month.com')
    expect(test).toHaveTextContent('Awaiting payment')
    expect(test).toHaveTextContent(formatNaira(4_300_000))
    expect(test).toHaveTextContent('20 Sept 2026')
    expect(noDomains).toHaveTextContent('Order DR-1003')
    expect(noDomains).not.toHaveTextContent('(test)')
    expect(noDomains).toHaveTextContent('No domains')
    expect(within(panel).getByRole('link', { name: 'Open order DR-1004' })).toHaveAttribute(
      'href',
      '/app/orders/1004',
    )
    expect(
      within(panel).queryByRole('link', { name: 'Open order DR-1001' }),
    ).not.toBeInTheDocument()
  })

  it('describes the latest events in words, each linked to its domain’s activity', async () => {
    const user = userEvent.setup()
    renderFull()

    await user.click(screen.getByRole('tab', { name: 'Activity' }))

    const panel = screen.getByRole('tabpanel', { name: 'Activity' })
    const [applied, autoRenewOff, paid] = items()
    expect(items()).toHaveLength(3)
    expect(applied).toHaveTextContent(
      'Nameservers applied at the registry: ns1.vercel-dns.com, ns2.vercel-dns.com',
    )
    expect(autoRenewOff).toHaveTextContent('Auto-renew turned off')
    expect(autoRenewOff).toHaveTextContent('soon.com')
    expect(paid).toHaveTextContent('Paid for in order DR-1001')
    expect(panel).not.toHaveTextContent('Registered')
    expect(
      within(panel).getAllByRole('link', { name: 'Activity for later.com' })[0],
    ).toHaveAttribute('href', '/app/domains/later.com/activity')
    expect(items()[1]).toHaveTextContent('22 Sept 2026')
  })

  it('moves between tabs from the keyboard', async () => {
    const user = userEvent.setup()
    renderFull()

    await user.click(screen.getByRole('tab', { name: 'Renewals' }))
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Orders' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Orders' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Orders' })).toBeInTheDocument()
  })

  it('says what will appear in each tab on a new account', async () => {
    const user = userEvent.setup()
    render(<ComingUp upcoming={empty.upcoming} orders={[]} events={[]} now={NOW} />)

    expect(screen.getByRole('tabpanel', { name: 'Renewals' })).toHaveTextContent(
      'Domains you register show their renewal dates here.',
    )
    await user.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByRole('tabpanel', { name: 'Orders' })).toHaveTextContent(
      'Your orders will appear here.',
    )
    await user.click(screen.getByRole('tab', { name: 'Activity' }))
    expect(screen.getByRole('tabpanel', { name: 'Activity' })).toHaveTextContent(
      'Registrations, renewals and nameserver changes will appear here.',
    )
  })
})
