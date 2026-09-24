import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { TransferFaq } from '../components/transfer-faq'
import { TransferGuide } from '../components/transfer-guide'

describe('TransferGuide', () => {
  it('walks through the four steps in order, starting from the check (N9b)', () => {
    render(<TransferGuide />)

    const steps = screen.getByRole('region', {
      name: 'Four steps, most of them at your old registrar',
    })
    expect(within(steps).getByText(/start the transfer from the result/)).toBeInTheDocument()
    expect(
      within(steps).getByText(/We check the code with the registry before you pay/),
    ).toBeInTheDocument()
    const list = within(steps).getByRole('list')
    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Unlock it', 'Get the auth code', 'Enter it and pay', 'Approve, or just wait'])
  })

  it('warns about the three things that break a transfer, with the shared lock period', () => {
    render(<TransferGuide />)

    const cautions = screen.getByRole('region', { name: 'Before you start' })
    expect(
      within(cautions)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      'Is your DNS hosted at your registrar?',
      'Can you read the email on the domain?',
      'Changed the owner recently?',
    ])
    expect(
      within(cautions).getByText(new RegExp(`against transfers for ${TRANSFER_LOCK_DAYS} days`)),
    ).toBeInTheDocument()
  })
})

describe('TransferFaq', () => {
  it('opens one answer at a time', async () => {
    const user = userEvent.setup()
    render(<TransferFaq />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'Transfer questions' }),
    ).toBeInTheDocument()
    const downtime = screen.getByRole('button', {
      name: 'Will my website go down during the transfer?',
    })
    expect(downtime).toHaveAttribute('aria-expanded', 'false')

    await user.click(downtime)
    expect(screen.getByText(/your nameservers come across unchanged/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'How long does it take?' }))
    expect(screen.getByText(/Up to five days once it is submitted/)).toBeVisible()
    expect(screen.queryByText(/your nameservers come across unchanged/)).not.toBeInTheDocument()
  })

  it('states the lock after registration from the shared rule', async () => {
    const user = userEvent.setup()
    render(<TransferFaq />)

    await user.click(
      screen.getByRole('button', { name: 'Can I transfer a domain I only just registered?' }),
    )
    expect(
      screen.getByText(new RegExp(`refuse a transfer for ${TRANSFER_LOCK_DAYS} days`)),
    ).toBeInTheDocument()
  })

  it('promises the auth code is never held over a bill (N14)', async () => {
    const user = userEvent.setup()
    render(<TransferFaq />)

    await user.click(screen.getByRole('button', { name: 'Can I move it away again later?' }))
    expect(screen.getByText(/never hold it back over an unpaid invoice/)).toBeInTheDocument()
  })
})
