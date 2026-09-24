import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BUSINESS } from '@/lib/business'
import { Faq } from '../components/faq'

/** The answer's panel: closed ones stay in the page, hidden by CSS (FaqItem). */
const panelOf = (text: RegExp) => screen.getByText(text).closest('[data-slot="accordion-content"]')

describe('Faq', () => {
  it('points people who are still stuck to the help centre and the contact address', () => {
    render(<Faq />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'Questions people actually ask' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'help centre' })).toHaveAttribute('href', '/help')
    expect(screen.getByRole('link', { name: BUSINESS.email })).toHaveAttribute(
      'href',
      `mailto:${BUSINESS.email}`,
    )
  })

  it('keeps answers closed until a question is opened — but in the page, for crawlers', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    const question = screen.getByRole('button', {
      name: 'Do I need hosting before I buy a domain?',
    })
    expect(question).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(/point it somewhere later/)).toHaveAttribute('data-state', 'closed')

    await user.click(question)

    expect(question).toHaveAttribute('aria-expanded', 'true')
    expect(panelOf(/point it somewhere later/)).toHaveAttribute('data-state', 'open')
  })

  it('shows one answer at a time', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    await user.click(screen.getByRole('button', { name: /renewal price sometimes higher/ }))
    expect(screen.getByText(/We always show both numbers/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Can I move my domain away later?' }))
    expect(panelOf(/never withhold it over an unpaid invoice/)).toHaveAttribute(
      'data-state',
      'open',
    )
    expect(panelOf(/We always show both numbers/)).toHaveAttribute('data-state', 'closed')
  })

  it('states the transfer lock from the shared rule, and how a transfer is started (N9b)', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    await user.click(screen.getByRole('button', { name: 'Can I transfer a domain I already own?' }))
    const answer = screen.getByText(/we check it with the registry, and you pay/)
    expect(answer).toHaveTextContent(`at least ${TRANSFER_LOCK_DAYS} days old`)
    expect(answer).toHaveTextContent('usually take up to five days')
  })
})
