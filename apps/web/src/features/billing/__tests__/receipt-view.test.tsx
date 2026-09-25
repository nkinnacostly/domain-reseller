import { formatNaira } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrderRefund } from '@/features/checkout/queries/orders'
import { BUSINESS } from '@/lib/business'
import { PrintButton } from '../components/print-button'
import { ReceiptLink } from '../components/receipt-link'
import { ReceiptView } from '../components/receipt-view'
import type { Receipt } from '../lib/receipt'

const RECEIPT: Receipt = {
  orderId: '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10',
  orderNumber: 'ND-001001',
  invoiceNumber: 'INV-000042',
  paidAt: '2026-09-24T09:15:00Z',
  testMode: false,
  customer: {
    name: 'Ada Okafor',
    company: 'Paidly Ltd',
    email: 'ada@example.com',
    address: ['12 Admiralty Way', 'Lagos, Lagos, 100001', 'Nigeria'],
  },
  lines: [
    {
      id: 'line-1',
      domain: 'getpaid.com',
      kind: 'register',
      years: 1,
      priceKobo: 1_840_000,
      renewalKobo: 1_870_000,
      failed: false,
    },
    {
      id: 'line-2',
      domain: 'getpaid.co',
      kind: 'register',
      years: 2,
      priceKobo: 7_450_000,
      renewalKobo: 5_610_000,
      failed: true,
    },
  ],
  subtotalKobo: 9_290_000,
  vatPct: 7.5,
  vatKobo: 696_750,
  totalKobo: 9_986_750,
  payment: {
    reference: 'MDH-6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10',
    transactionId: '9990001',
    method: 'Card, through Flutterwave',
    amountKobo: 9_986_750,
  },
}

const REFUND: OrderRefund = {
  id: 'refund-1',
  domain: 'getpaid.co',
  reason: 'registration_failed',
  amountKobo: 8_008_750,
  state: 'processing',
  refundedAt: null,
  testMode: false,
}

const ready = (receipt: Partial<Receipt> = {}, refunds: OrderRefund[] = []) =>
  render(<ReceiptView lookup={{ state: 'ready', receipt: { ...RECEIPT, ...receipt }, refunds }} />)

const document_ = () => screen.getByRole('article', { name: /^(Tax invoice|Receipt)$/ })

afterEach(() => vi.restoreAllMocks())

describe('ReceiptView — the states around a receipt (S11)', () => {
  it('says when the receipt could not be loaded, with a way back', () => {
    render(<ReceiptView lookup={{ state: 'error' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t load this receipt just now.')
    expect(screen.getByRole('link', { name: 'Back to your orders' })).toHaveAttribute(
      'href',
      '/app/orders',
    )
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('says an unpaid order has no receipt, and links back to it', () => {
    render(
      <ReceiptView
        lookup={{ state: 'unpaid', orderId: RECEIPT.orderId, orderNumber: 'ND-001001' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'No receipt for this order' })).toBeInTheDocument()
    expect(
      screen.getByText(/Order ND-001001 has not been paid, so it has no receipt\./),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to the order' })).toHaveAttribute(
      'href',
      `/app/orders/${RECEIPT.orderId}`,
    )
    expect(screen.queryByRole('button', { name: 'Print or save as PDF' })).not.toBeInTheDocument()
  })

  it('titles the page with the invoice number, crumbs back to the order, and offers printing', () => {
    ready()
    expect(screen.getByRole('heading', { level: 1, name: 'Receipt INV-000042' })).toBeVisible()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'ND-001001' })).toHaveAttribute(
      'href',
      `/app/orders/${RECEIPT.orderId}`,
    )
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeEnabled()
    // Only the receipt prints: the header with its links and button is screen-only.
    const title = screen.getByRole('heading', { level: 1 })
    expect(title.closest('header')?.parentElement).toHaveClass('print:hidden')
    expect(document_().closest('.print\\:hidden')).toBeNull()
  })
})

describe('ReceiptDocument — what the receipt says (CMP-17, FR-C5, N8)', () => {
  it('names the invoice, the date paid in Lagos, and the order', () => {
    ready()
    const header = within(document_())
    expect(header.getByText('INV-000042')).toHaveAttribute('data-invoice-number')
    expect(header.getByText('24 September 2026')).toBeVisible()
    expect(header.getByText('ND-001001')).toBeVisible()
  })

  it('names the seller, with its CAC number and TIN, from the business facts only', () => {
    ready()
    const seller = screen.getByRole('region', { name: 'From' })
    expect(seller).toHaveTextContent(BUSINESS.operator)
    expect(seller).toHaveTextContent(`Operator of ${BUSINESS.brand}`)
    expect(seller).toHaveTextContent(BUSINESS.rcNumber)
    expect(seller).toHaveTextContent(`TIN ${BUSINESS.tin}`)
    expect(seller).toHaveTextContent(BUSINESS.site)
    expect(seller).toHaveTextContent(BUSINESS.email)
  })

  it('calls a live receipt a tax invoice, and a test one only a receipt (CMP-17)', () => {
    const { unmount } = ready()
    expect(screen.getByRole('article', { name: 'Tax invoice' })).toBeVisible()
    unmount()
    ready({ testMode: true, invoiceNumber: 'TEST-INV-000007' })
    expect(screen.getByRole('article', { name: 'Receipt' })).toBeVisible()
  })

  it('bills the registrant recorded on the order', () => {
    ready()
    const customer = screen.getByRole('region', { name: 'Billed to' })
    for (const part of [
      'Ada Okafor',
      'Paidly Ltd',
      'ada@example.com',
      '12 Admiralty Way',
      'Nigeria',
    ]) {
      expect(customer).toHaveTextContent(part)
    }
  })

  it('says when no registrant was recorded, rather than leave a gap', () => {
    ready({ customer: { name: null, company: null, email: null, address: [] } })
    expect(screen.getByRole('region', { name: 'Billed to' })).toHaveTextContent(
      'No registrant details were recorded.',
    )
  })

  it('lists every line with what it was, its years, its price and its renewal price', () => {
    ready()
    const table = screen.getByRole('table', { name: 'What this order paid for' })
    const [, first, second] = within(table).getAllByRole('row')
    expect(first).toHaveTextContent(
      `getpaid.comRegistration, 1 year · renews at ${formatNaira(1_870_000)}/yr${formatNaira(1_840_000)}`,
    )
    expect(second).toHaveTextContent(
      `Registration, 2 years · renews at ${formatNaira(5_610_000)}/yr`,
    )
    // FR-R2 — the receipt says what was not registered.
    expect(second).toHaveTextContent('Not registered')
    expect(first).not.toHaveTextContent('Not registered')
  })

  it('itemises the subtotal, VAT at the order’s own rate, and the total', () => {
    ready()
    const table = screen.getByRole('table', { name: 'What this order paid for' })
    expect(
      within(table).getByRole('rowheader', { name: 'Subtotal' }).parentElement,
    ).toHaveTextContent(formatNaira(9_290_000))
    expect(
      within(table).getByRole('rowheader', { name: 'VAT (7.5%)' }).parentElement,
    ).toHaveTextContent(formatNaira(696_750))
    expect(within(table).getByRole('rowheader', { name: 'Total' }).parentElement).toHaveTextContent(
      formatNaira(9_986_750),
    )
  })

  it('shows how it was paid, and both references', () => {
    ready()
    const payment = screen.getByRole('region', { name: 'Payment' })
    expect(payment).toHaveTextContent('MethodCard, through Flutterwave')
    expect(payment).toHaveTextContent(`Amount paid${formatNaira(9_986_750)}`)
    expect(payment).toHaveTextContent('Payment referenceMDH-6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10')
    expect(payment).toHaveTextContent('Flutterwave transaction9990001')
  })

  it('leaves out what it does not know about the charge', () => {
    ready({
      payment: {
        reference: 'MDH-abc',
        transactionId: null,
        method: 'Flutterwave',
        amountKobo: null,
      },
    })
    const payment = screen.getByRole('region', { name: 'Payment' })
    expect(payment).not.toHaveTextContent('Amount paid')
    expect(payment).not.toHaveTextContent('Flutterwave transaction')
  })

  it('lists refunds on the order below the total', () => {
    ready({}, [REFUND])
    const refunds = within(document_()).getByRole('region', { name: 'Refunds' })
    expect(refunds).toHaveTextContent('getpaid.co')
    expect(refunds).toHaveTextContent(formatNaira(8_008_750))
  })

  it('says plainly that a test payment is not a tax invoice', () => {
    ready({ testMode: true, invoiceNumber: 'TEST-INV-000007' })
    expect(document_()).toHaveTextContent('Test payment — not a tax invoice.')
    expect(document_()).toHaveTextContent('no money moved')
  })

  it('carries no test notice on a live receipt', () => {
    ready()
    expect(document_()).not.toHaveTextContent(/Test payment/)
  })
})

describe('PrintButton', () => {
  it('opens the print dialog, which also saves as PDF', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    render(<PrintButton />)
    await user.click(screen.getByRole('button', { name: 'Print or save as PDF' }))
    expect(print).toHaveBeenCalledOnce()
  })
})

describe('ReceiptLink', () => {
  it('goes to the order’s receipt', () => {
    render(<ReceiptLink orderId="order-1" />)
    expect(screen.getByRole('link', { name: 'View receipt' })).toHaveAttribute(
      'href',
      '/app/orders/order-1/receipt',
    )
  })

  it('names the invoice when it is known, so a list can tell receipts apart', () => {
    render(<ReceiptLink orderId="order-1" invoiceNumber="INV-000042" />)
    expect(screen.getByRole('link', { name: 'Receipt INV-000042' })).toBeVisible()
  })
})
