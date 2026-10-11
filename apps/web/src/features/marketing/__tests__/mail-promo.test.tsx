import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MailPromo } from '../components/mail-promo'

/** The way across to MyDomainsHub Mail, saying only what Mail does (N9b). */
describe('MailPromo', () => {
  it('names Mail, says what it sends and how, and links to its site and pricing', () => {
    render(<MailPromo />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Send email from your domain',
    )
    expect(screen.getByRole('link', { name: 'Visit MyDomainsHub Mail' })).toHaveAttribute(
      'href',
      'https://emails.mydomainshub.com',
    )
    expect(screen.getByRole('link', { name: 'See Mail pricing' })).toHaveAttribute(
      'href',
      'https://emails.mydomainshub.com/pricing',
    )
    const points = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(points.map((point) => within(point).getByRole('heading').textContent)).toEqual([
      'Receipts, sign-in links and alerts',
      'By API or SMTP',
      'Priced in naira',
    ])
    // Numbers belong to Mail's own pages, read from its plan rows.
    expect(document.body.textContent).not.toMatch(/\d{3,}/)
  })
})
