import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainBadges, PanelNote } from '../components/domain-badges'
import { DomainTabs } from '../components/domain-tabs'

const pathname = vi.hoisted(() => ({ current: '/app/domains/getpaid.com' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))

const TABS = [
  ['Overview', '/app/domains/getpaid.com'],
  ['Renew', '/app/domains/getpaid.com/renew'],
  ['Nameservers', '/app/domains/getpaid.com/nameservers'],
  ['Contacts', '/app/domains/getpaid.com/contacts'],
  ['Security', '/app/domains/getpaid.com/security'],
  ['Activity', '/app/domains/getpaid.com/activity'],
] as const

function tab(name: string) {
  return within(screen.getByRole('navigation', { name: 'Domain' })).getByRole('link', {
    name,
  })
}

describe('DomainTabs (FR-P6)', () => {
  beforeEach(() => {
    pathname.current = '/app/domains/getpaid.com'
  })

  it('gives each tab its own page, so the URL says where you are', () => {
    render(<DomainTabs domain="getpaid.com" />)
    for (const [name, href] of TABS) {
      expect(tab(name)).toHaveAttribute('href', href)
    }
  })

  it('offers the tabs in order, with Renew straight after Overview', () => {
    render(<DomainTabs domain="getpaid.com" />)
    const links = within(screen.getByRole('navigation', { name: 'Domain' })).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(TABS.map(([name]) => name))
  })

  it('marks Renew as the current page on the renew page', () => {
    pathname.current = '/app/domains/getpaid.com/renew'
    render(<DomainTabs domain="getpaid.com" />)
    expect(tab('Renew')).toHaveAttribute('aria-current', 'page')
    expect(tab('Overview')).not.toHaveAttribute('aria-current')
  })

  it('marks Overview as the current page only on the domain’s own address', () => {
    render(<DomainTabs domain="getpaid.com" />)
    expect(tab('Overview')).toHaveAttribute('aria-current', 'page')
    expect(tab('Overview')).toHaveAttribute('data-current', 'true')
    for (const [name] of TABS.slice(1)) {
      expect(tab(name)).not.toHaveAttribute('aria-current')
      expect(tab(name)).not.toHaveAttribute('data-current')
    }
  })

  it('moves "you are here" to a sub-page, and off Overview', () => {
    pathname.current = '/app/domains/getpaid.com/nameservers'
    render(<DomainTabs domain="getpaid.com" />)
    expect(tab('Nameservers')).toHaveAttribute('aria-current', 'page')
    expect(tab('Nameservers')).toHaveAttribute('data-current', 'true')
    expect(tab('Overview')).not.toHaveAttribute('aria-current')
  })
})

describe('DomainBadges', () => {
  it('labels a demo domain so nobody mistakes it for a real one', () => {
    render(<DomainBadges source="demo" testMode={false} />)
    expect(screen.getByText('Demo')).toBeInTheDocument()
  })

  it('labels a domain bought with a test payment', () => {
    render(<DomainBadges source="registration" testMode />)
    expect(screen.getByText('Test order')).toBeInTheDocument()
  })

  it('calls a demo a demo, even if it came from a test order', () => {
    render(<DomainBadges source="demo" testMode />)
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.queryByText('Test order')).not.toBeInTheDocument()
  })

  it('adds nothing to a real domain', () => {
    const { container } = render(<DomainBadges source="registration" testMode={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('PanelNote', () => {
  it('leads with what is true, then the detail', () => {
    render(<PanelNote title="Registering.">Your payment is in.</PanelNote>)
    expect(screen.getByText('Registering.')).toBeInTheDocument()
    expect(screen.getByText('Registering.').parentElement).toHaveTextContent(
      'Registering. Your payment is in.',
    )
  })

  it('stands alone when there is no detail to add', () => {
    render(<PanelNote title="Demo domain." />)
    expect(screen.getByText('Demo domain.').parentElement).toHaveTextContent(/^Demo domain\.$/)
  })
})
