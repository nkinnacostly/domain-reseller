import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Portfolio } from '../components/portfolio'
import type { PortfolioDomain } from '../lib/portfolio'

// 24 Sept 2026, 10:00 in Lagos (UTC+1).
const NOW = new Date('2026-09-24T09:00:00Z')
const DAY = 86_400_000
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY + 3_600_000).toISOString()

function domain(name: string, overrides: Partial<PortfolioDomain> = {}): PortfolioDomain {
  return {
    id: name,
    domainName: name,
    tld: name.split('.').slice(1).join('.'),
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

const PORTFOLIO = [
  domain('later.com'),
  domain('soon.com', { expiresAt: inDays(5), autoRenew: false, delegationStatus: 'undelegated' }),
  domain('gone.com', {
    status: 'expired_grace',
    expiresAt: inDays(-6),
    delegationStatus: 'failed',
  }),
  domain('moving.ng', { pendingNameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] }),
  domain('waiting.com', {
    status: 'pending',
    expiresAt: null,
    testMode: true,
    delegationStatus: 'pending',
  }),
  domain('sample.com', { source: 'demo', expiresAt: inDays(40) }),
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

/** The portfolio's own links carry data-domain; nothing else on the page does. */
function rows() {
  const cards = screen.getByRole('list', { name: 'Your domains' })
  return within(cards)
    .getAllByRole('link')
    .map((link) => link.getAttribute('data-domain'))
}

function card(name: string) {
  const link = within(screen.getByRole('list', { name: 'Your domains' }))
    .getAllByRole('link')
    .find((candidate) => candidate.getAttribute('data-domain') === name)
  if (!link) throw new Error(`No card for ${name}`)
  return link
}

function tableRow(name: string) {
  const table = screen.getByRole('table', { name: /^Your domains, soonest expiry first/ })
  const row = within(table)
    .getByRole('rowheader', { name: new RegExp(`^${name}`) })
    .closest('tr')
  if (!row) throw new Error(`No row for ${name}`)
  return within(row).getAllByRole('cell')
}

describe('Portfolio with no domains yet', () => {
  it('shows where to start instead of an empty table', () => {
    render(<Portfolio domains={[]} query="" within={null} />)

    const section = screen.getByRole('region', { name: 'Your domains' })
    expect(within(section).getByRole('heading', { name: 'No domains yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Search for a domain' })).toHaveAttribute(
      'href',
      '/search',
    )
    expect(screen.getByRole('link', { name: 'Transfer one in' })).toHaveAttribute(
      'href',
      '/transfer',
    )
  })

  it('offers no search or expiry filter when there is nothing to filter', () => {
    render(<Portfolio domains={[]} query="" within={null} />)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Expiry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('Portfolio (FR-P2)', () => {
  it('lists every domain, soonest expiry first, unregistered ones last', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)
    expect(rows()).toEqual([
      'gone.com',
      'soon.com',
      'sample.com',
      'later.com',
      'moving.ng',
      'waiting.com',
    ])
  })

  it('says, for each domain, its status, expiry, auto-renew and where it points', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)

    expect(card('soon.com')).toHaveTextContent('Expires in 5 days')
    expect(card('soon.com')).toHaveTextContent('Expires 29 Sept 2026')
    expect(card('soon.com')).toHaveTextContent('Auto-renew off · Not pointed at your host yet')
    expect(card('later.com')).toHaveTextContent('Auto-renew on · Pointed and working')
    expect(card('gone.com')).toHaveTextContent('Expired')
    expect(card('gone.com')).toHaveTextContent('Not working')
    expect(card('moving.ng')).toHaveTextContent('Change waiting')
    expect(card('waiting.com')).toHaveTextContent('Registering')
    expect(card('waiting.com')).toHaveTextContent('Expires a year after registration')
    expect(card('waiting.com')).toHaveTextContent('Waiting to take effect')
  })

  it('labels demo and test-order domains, and nothing else', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)
    expect(card('sample.com')).toHaveTextContent('Demo')
    expect(card('waiting.com')).toHaveTextContent('Test order')
    expect(card('later.com')).not.toHaveTextContent(/Demo|Test order/)
  })

  it('links each domain to its own page', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)
    expect(card('soon.com')).toHaveAttribute('href', '/app/domains/soon.com')
  })

  it('gives wide screens the same facts as a table', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)

    const [status, expires, autoRenew, nameservers] = tableRow('soon.com')
    expect(status).toHaveTextContent('Expires in 5 days')
    expect(expires).toHaveTextContent('29 Sept 2026in 5 days')
    expect(autoRenew).toHaveTextContent('Off')
    expect(nameservers).toHaveTextContent('Not pointed at your host yet')

    expect(tableRow('gone.com')[1]).toHaveTextContent('6 days ago')
    expect(tableRow('waiting.com')[1]).toHaveTextContent('After registration')
    expect(tableRow('moving.ng')[3]).toHaveTextContent('Change waiting')
    expect(tableRow('later.com')[2]).toHaveTextContent('On')
    expect(tableRow('sample.com')[0]?.closest('tr')).toHaveTextContent('Demo')
  })

  it('searches by name, whatever the case, and keeps what was typed in the box', () => {
    render(<Portfolio domains={PORTFOLIO} query="MOVING" within={null} />)

    const box = screen.getByRole('searchbox', { name: 'Search your domains' })
    expect(box).toHaveValue('MOVING')
    expect(box).toHaveAttribute('name', 'q')
    expect(box.closest('form')).toHaveAttribute('action', '/app/domains')
    expect(box.closest('form')).toHaveAttribute('method', 'get')
    expect(rows()).toEqual(['moving.ng'])
  })

  it('says so when nothing matches the search', () => {
    render(<Portfolio domains={PORTFOLIO} query="nothing-like-it" within={null} />)
    expect(screen.getByText('No domain matches that search.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Your domains' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('Portfolio expiry view (FR-P5)', () => {
  it('offers every window, marking the one being shown', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={null} />)
    const nav = screen.getByRole('navigation', { name: 'Expiry' })
    const links = within(nav).getAllByRole('link')

    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['All', '/app/domains'],
      ['Expiring in 7 days', '/app/domains?within=7'],
      ['Expiring in 30 days', '/app/domains?within=30'],
      ['Expiring in 60 days', '/app/domains?within=60'],
      ['Expiring in 90 days', '/app/domains?within=90'],
    ])
    expect(within(nav).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Expiring in 7 days' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('lists only what expires in the window, already expired included', () => {
    render(<Portfolio domains={PORTFOLIO} query="" within={7} />)
    expect(rows()).toEqual(['gone.com', 'soon.com'])
    expect(
      within(screen.getByRole('navigation', { name: 'Expiry' })).getByRole('link', {
        name: 'Expiring in 7 days',
      }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the search when switching window, and the window when searching', () => {
    render(<Portfolio domains={PORTFOLIO} query="soon" within={30} />)
    const nav = screen.getByRole('navigation', { name: 'Expiry' })

    expect(within(nav).getByRole('link', { name: 'All' })).toHaveAttribute(
      'href',
      '/app/domains?q=soon',
    )
    expect(within(nav).getByRole('link', { name: 'Expiring in 90 days' })).toHaveAttribute(
      'href',
      '/app/domains?q=soon&within=90',
    )
    const form = screen.getByRole('searchbox', { name: 'Search your domains' }).closest('form')
    expect(form?.querySelector('input[type="hidden"][name="within"]')).toHaveValue('30')
  })

  it('says so when nothing expires in the window', () => {
    render(<Portfolio domains={[domain('later.com')]} query="" within={7} />)
    expect(screen.getByText('Nothing expires in the next 7 days.')).toBeInTheDocument()
  })
})
