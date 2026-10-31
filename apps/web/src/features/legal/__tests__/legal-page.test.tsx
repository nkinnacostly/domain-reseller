import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSINESS } from '@/lib/business'
import { EmailLink, LegalPage, LegalSection, PolicyLink } from '../components/legal-page'
import { LEGAL_DOCUMENTS } from '../lib/documents'

const pathname = vi.hoisted(() => ({ current: '/legal/privacy' }))

vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))
// The footer's year is a cached read (site-footer.tsx).
vi.mock('next/cache', () => ({ cacheLife: () => undefined }))
// The header asks Supabase whether this browser holds a session.
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}))

beforeEach(() => {
  pathname.current = '/legal/privacy'
})

describe('LegalPage', () => {
  it('heads the page with the title and when the text last changed', () => {
    render(
      <LegalPage path="/legal/privacy" title="Privacy notice" intro="What we collect and why.">
        <p>Body text.</p>
      </LegalPage>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeInTheDocument()
    expect(screen.getByText(`Last updated ${BUSINESS.lastUpdated}`)).toBeInTheDocument()
    expect(screen.getByText('What we collect and why.')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText('Body text.')).toBeInTheDocument()
  })

  it('lists every legal document beside the text, marking the one being read', () => {
    render(
      <LegalPage path="/legal/privacy" title="Privacy notice">
        <p>Body text.</p>
      </LegalPage>,
    )

    const nav = screen.getByRole('navigation', { name: 'Legal documents' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      LEGAL_DOCUMENTS.map((document) => document.href),
    )
    expect(within(nav).getByRole('link', { name: 'Privacy notice' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Refund policy' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('tells search engines where the page sits: Home, Legal, then the document', () => {
    const { container } = render(
      <LegalPage path="/legal/privacy" title="Privacy notice">
        <p>Body text.</p>
      </LegalPage>,
    )
    const data = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}',
    )
    const trail = data['@graph'][0]
    expect(trail['@type']).toBe('BreadcrumbList')
    expect(
      trail.itemListElement.map((item: { name: string; item: string }) => [
        item.name,
        new URL(item.item).pathname,
      ]),
    ).toEqual([
      ['Home', '/'],
      ['Legal', '/legal'],
      ['Privacy notice', '/legal/privacy'],
    ])
  })

  it('leaves the document list off help pages', () => {
    pathname.current = '/help'
    render(
      <LegalPage path="/help" title="Help centre" nav="none" icons={[]}>
        <p>Answers.</p>
      </LegalPage>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Help centre' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Legal documents' })).not.toBeInTheDocument()
  })

  it('keeps the site header and the compliance footer around the text', () => {
    render(
      <LegalPage path="/legal/refunds" title="Refund policy">
        <p>Body text.</p>
      </LegalPage>,
    )

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/not itself\s+ICANN-accredited/)
  })
})

describe('LegalSection', () => {
  it('is a region named by its heading, with an anchor a clause can be linked to', () => {
    render(
      <LegalSection id="refund-window" title="When you get your money back">
        <p>Within five business days.</p>
      </LegalSection>,
    )

    const region = screen.getByRole('region', { name: 'When you get your money back' })
    expect(within(region).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'refund-window')
    expect(region).toHaveTextContent('Within five business days.')
  })
})

describe('PolicyLink', () => {
  it('opens an official text in a new tab, says so, and does not leak the opener', () => {
    render(<PolicyLink href="https://www.icann.org/udrp">the UDRP</PolicyLink>)

    const link = screen.getByRole('link', { name: /^the UDRP\s*\(opens in a new tab\)$/ })
    expect(link).toHaveAttribute('href', 'https://www.icann.org/udrp')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('EmailLink', () => {
  it('shows the contact address and links to it', () => {
    render(<EmailLink />)

    expect(screen.getByRole('link', { name: BUSINESS.email })).toHaveAttribute(
      'href',
      `mailto:${BUSINESS.email}`,
    )
  })
})
