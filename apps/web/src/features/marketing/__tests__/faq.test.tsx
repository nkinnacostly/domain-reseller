import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BUSINESS } from '@/lib/business'
import { Faq } from '../components/faq'

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

  it('keeps answers closed until a question is opened', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    const question = screen.getByRole('button', {
      name: 'Do I need hosting before I buy a domain?',
    })
    expect(question).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/point it somewhere later/)).not.toBeInTheDocument()

    await user.click(question)

    expect(question).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/point it somewhere later/)).toBeVisible()
  })

  it('shows one answer at a time', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    await user.click(screen.getByRole('button', { name: /renewal price sometimes higher/ }))
    expect(screen.getByText(/We always show both numbers/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Can I move my domain away later?' }))
    expect(screen.getByText(/never withhold it over an unpaid invoice/)).toBeInTheDocument()
    expect(screen.queryByText(/We always show both numbers/)).not.toBeInTheDocument()
  })

  it('states the transfer lock from the shared rule, and that transfers are not open yet (N9b)', async () => {
    const user = userEvent.setup()
    render(<Faq />)

    await user.click(screen.getByRole('button', { name: 'Can I transfer a domain I already own?' }))
    const answer = screen.getByText(/starting a transfer is not available/)
    expect(answer).toHaveTextContent(`at least ${TRANSFER_LOCK_DAYS} days old`)
  })
})
