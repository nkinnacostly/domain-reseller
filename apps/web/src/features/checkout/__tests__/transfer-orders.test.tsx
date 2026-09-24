import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OrderStatus } from '../components/order-status'
import { registrantFromForm } from '../lib/contact'
import { lineStatus, orderKind, orderNotice, paymentNotice } from '../lib/progress'
import { refundLabel } from '../lib/refunds'

/** How a transfer-in order reads (PRD E9, FR-T3): honest about the wait, and about refunds. */

describe('a transfer order', () => {
  it('is told apart from a registration and a renewal by its line', () => {
    expect(orderKind([{ item_type: 'transfer' }])).toBe('transfer')
    expect(orderKind([{ item_type: 'renew' }])).toBe('renew')
    expect(orderKind([{ item_type: 'register' }])).toBe('register')
  })

  it('says it is queued once paid, and never that it is done', () => {
    expect(orderNotice('paid', false, 'transfer')).toEqual({
      tone: 'success',
      text: expect.stringMatching(/^Your transfer is paid and queued\./),
    })
  })

  it('gives the expected window and who it waits on while it moves (FR-T3)', () => {
    const notice = orderNotice('provisioning', false, 'transfer')
    expect(notice?.text).toMatch(/usually take up to five days/)
    expect(notice?.text).toMatch(/current registrar may email the domain’s owner/)
    expect(notice?.text).toMatch(/registry completes it after five days/)
  })

  it('says only once it has landed that it has transferred', () => {
    expect(orderNotice('completed', false, 'transfer')?.text).toBe(
      'Your domain has transferred in.',
    )
  })

  it('says a failed transfer is refunded — or, for a test payment, that no money moved', () => {
    expect(orderNotice('failed', false, 'transfer')).toEqual({
      tone: 'error',
      text: expect.stringMatching(/refunded automatically — see Refunds below/),
    })
    expect(orderNotice('partially_failed', true, 'transfer')?.text).toMatch(/No money moved\.$/)
  })

  it('marks a test transfer as the sandbox’s, and a closed order as uncharged', () => {
    expect(orderNotice('completed', true, 'transfer')?.text).toMatch(
      /Test transfers go to the registrar’s test system/,
    )
    expect(orderNotice('cancelled', false, 'transfer')?.text).toMatch(/nothing was charged/)
    expect(orderNotice('awaiting_payment', false, 'transfer')).toBeNull()
  })

  it('labels its line as a transfer, not a registration', () => {
    expect(lineStatus('transfer', 'pending')).toBe('Queued')
    expect(lineStatus('transfer', 'provisioning')).toBe('Transferring')
    expect(lineStatus('transfer', 'completed')).toBe('Transferred')
    expect(lineStatus('transfer', 'failed')).toBe('Failed')
    expect(lineStatus('register', 'provisioning')).toBe('Registering')
  })

  it('sends a cancelled or failed payment back to the transfer page', () => {
    for (const payment of ['cancelled', 'failed']) {
      expect(paymentNotice(payment, 'transfer', 'hello@example.com')?.text).toMatch(
        /start the transfer again from the transfer page\.$/,
      )
    }
    expect(paymentNotice('underpaid', 'transfer', 'hello@example.com')?.text).toMatch(
      /nothing has been transferred/,
    )
  })

  it('names the refund of a failed transfer after the domain', () => {
    expect(refundLabel({ reason: 'transfer_failed', domain: 'getpaid.com' })).toBe(
      'Transfer of getpaid.com',
    )
    expect(refundLabel({ reason: 'transfer_failed', domain: null })).toBe('Refund')
  })

  it('shows its status as a transfer', () => {
    const { rerender } = render(<OrderStatus status="paid" kind="transfer" />)
    expect(screen.getByText('Paid — transfer queued')).toBeInTheDocument()
    rerender(<OrderStatus status="provisioning" kind="transfer" />)
    expect(screen.getByText('Transferring')).toBeInTheDocument()
    rerender(<OrderStatus status="completed" kind="transfer" />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })
})

describe('registrantFromForm', () => {
  it('reads every registrant field from a submitted form, blanks as empty strings', () => {
    const form = new FormData()
    form.set('firstName', 'Ada')
    form.set('lastName', 'Okafor')
    form.set('email', 'ada@example.com')
    form.set('country', 'NG')
    expect(registrantFromForm(form)).toEqual({
      firstName: 'Ada',
      lastName: 'Okafor',
      company: '',
      email: 'ada@example.com',
      phoneCountryCode: '',
      phone: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'NG',
    })
  })
})
