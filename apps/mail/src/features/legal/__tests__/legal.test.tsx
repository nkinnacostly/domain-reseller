import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGAL_DRAFT_NOTICE } from '@/lib/business'
import { DraftMark, EmailLink, LegalPage, LegalSection } from '../components/legal-page'
import { ABUSE_FIELDS, ABUSE_SUBJECT, abuseMailto } from '../lib/abuse-report'
import { LEGAL_DOCUMENTS } from '../lib/documents'
import { SUB_PROCESSORS } from '../lib/sub-processors'

const pathname = vi.hoisted(() => ({ current: '/legal/terms' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))

afterEach(() => {
  pathname.current = '/legal/terms'
})

describe('legal pages are marked as drafts (MAIL-SPEC §14.5)', () => {
  it('on the page and in an HTML comment', () => {
    const { container } = render(<DraftMark />)
    expect(screen.getByText(LEGAL_DRAFT_NOTICE)).toBeInTheDocument()
    expect(container.innerHTML).toContain(`<!-- ${LEGAL_DRAFT_NOTICE} -->`)
    expect(LEGAL_DRAFT_NOTICE).toBe('Draft — pending legal review')
  })

  it('a legal document carries the mark, the warning, its date and the other documents', () => {
    const { container } = render(
      <LegalPage path="/legal/terms" title="Terms of Service">
        <LegalSection id="who" title="Who we are">
          <p>
            Email <EmailLink />.
          </p>
        </LegalSection>
      </LegalPage>,
    )
    expect(container.innerHTML).toContain(`<!-- ${LEGAL_DRAFT_NOTICE} -->`)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Terms of Service')
    expect(screen.getByText('Last updated 8 October 2026')).toBeInTheDocument()
    expect(screen.getByRole('article')).toHaveTextContent(
      'Our lawyer has not reviewed this document',
    )
    const nav = screen.getByRole('navigation', { name: 'Legal documents' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      LEGAL_DOCUMENTS.map((document) => document.href),
    )
    expect(within(nav).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('region', { name: 'Who we are' })).toHaveTextContent(
      'hello@mydomainshub.com',
    )
    const data = JSON.parse(container.querySelector('script')?.innerHTML ?? '{}')
    expect(data['@graph'][0].itemListElement.map((item: { name: string }) => item.name)).toEqual([
      'Home',
      'Legal',
      'Terms of Service',
    ])
  })

  it('the index is marked, without the in-page list', () => {
    pathname.current = '/legal'
    render(
      <LegalPage kind="index" path="/legal" title="Legal">
        <p>Documents</p>
      </LegalPage>,
    )
    expect(screen.getByText(LEGAL_DRAFT_NOTICE)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Legal documents' })).toBeNull()
  })

  it('support pages are not legal text: no draft mark', () => {
    pathname.current = '/contact'
    const { container } = render(
      <LegalPage kind="support" path="/contact" title="Contact us" structuredData={[{ a: 1 }]}>
        <p>Write to us</p>
      </LegalPage>,
    )
    expect(screen.queryByText(LEGAL_DRAFT_NOTICE)).toBeNull()
    expect(container.innerHTML).not.toContain('<!--')
    expect(screen.getByText('Support')).toBeInTheDocument()
  })
})

describe('the documents and their facts', () => {
  it('five documents, under /legal', () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.title)).toEqual([
      'Terms of Service',
      'Acceptable Use Policy',
      'Privacy Notice',
      'Data Processing Agreement',
      'Sub-processors',
    ])
  })

  it('names the six sub-processors, with SES in eu-west-2', () => {
    expect(SUB_PROCESSORS.map((processor) => processor.name.split(' ')[0])).toEqual([
      'Amazon',
      'Supabase',
      'Vercel',
      'Fly.io',
      'Flutterwave',
      'Cloudflare',
    ])
    expect(SUB_PROCESSORS[0]?.location).toContain('eu-west-2')
  })

  it('an abuse report is a mailto with the subject and the fields to fill in — nothing stored', () => {
    const url = new URL(abuseMailto())
    expect(url.protocol).toBe('mailto:')
    expect(url.pathname).toBe('hello@mydomainshub.com')
    expect(url.searchParams.get('subject')).toBe(ABUSE_SUBJECT)
    const body = url.searchParams.get('body') ?? ''
    for (const field of ABUSE_FIELDS) expect(body).toContain(`${field}:`)
    expect(ABUSE_FIELDS).toContain('The full message headers')
  })
})
