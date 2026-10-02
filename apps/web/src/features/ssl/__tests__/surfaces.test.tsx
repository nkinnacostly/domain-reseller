import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lineLabel, renewalText, toReceipt } from '@/features/billing/lib/receipt'
import { removeSslCartLine } from '@/features/cart/actions/ssl'
import { SslCartLine } from '@/features/cart/components/ssl-cart-line'
import type { SslLineView } from '@/features/cart/lib/view'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { lineStatus, orderKind, orderNotice, paymentNotice } from '@/features/checkout/lib/progress'
import { refundLabel } from '@/features/checkout/lib/refunds'
import { llmsTxt } from '@/features/seo/lib/llms'
import { certificateServiceLd } from '@/features/seo/lib/structured-data'
import { SSL_FAQS, SslGuide } from '../components/ssl-guide'

vi.mock('@/features/cart/actions/ssl', () => ({ removeSslCartLine: vi.fn() }))
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

/** FR-SSL-6: certificates wherever an order is shown — cart, order page, receipt, refunds, llms.txt. */

beforeEach(() => vi.resetAllMocks())

describe('a certificate in the cart', () => {
  const LINE: SslLineView = {
    id: '00000000-0000-4000-8000-000000000001',
    site: 'example.com',
    name: '*.example.com',
    productName: 'Sectigo PositiveSSL Wildcard',
    kind: 'wildcard',
    covers: 'Every name one level under example.com',
    status: 'held',
    total: '₦135,000',
    renewal:
      'It never renews by itself: when the subscription ends, buy a new certificate — ₦135,000 at today’s price.',
    term: '1-year subscription',
    was: null,
    heldUntil: '1:20 pm',
  }

  it('shows the name, what it covers, the price with its term and the price of a new one (N8)', async () => {
    const user = userEvent.setup()
    vi.mocked(removeSslCartLine).mockResolvedValue({ data: { count: 0 } } as never)
    render(
      <ul>
        <SslCartLine line={LINE} />
      </ul>,
    )
    const item = screen.getByRole('listitem', { name: '*.example.com' })
    expect(item).toHaveTextContent('Sectigo PositiveSSL Wildcard')
    expect(item).toHaveTextContent('₦135,000')
    expect(item).toHaveTextContent('1-year subscription')
    expect(item).toHaveTextContent('You install it on your own server or hosting.')
    expect(item).toHaveTextContent('never renews by itself')
    expect(item).toHaveTextContent('Price held until 1:20 pm')
    await user.click(
      screen.getByRole('button', { name: 'Remove the certificate for *.example.com' }),
    )
    expect(removeSslCartLine).toHaveBeenCalledWith({ lineId: LINE.id })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('shows a changed price, one we no longer sell, and a failed removal', async () => {
    const user = userEvent.setup()
    vi.mocked(removeSslCartLine).mockResolvedValue({
      data: { error: 'Something went wrong' },
    } as never)
    const { unmount } = render(
      <ul>
        <SslCartLine line={{ ...LINE, status: 'changed', was: '₦130,000' }} />
      </ul>,
    )
    expect(screen.getByText('Price changed: was ₦130,000, now ₦135,000')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Remove/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
    unmount()
    render(
      <ul>
        <SslCartLine line={{ ...LINE, status: 'unavailable' }} />
      </ul>,
    )
    expect(screen.getByText(/We no longer sell this certificate/)).toBeInTheDocument()
    expect(screen.queryByText('₦135,000')).not.toBeInTheDocument()
  })
})

describe('an order of certificates', () => {
  it('is an SSL order only when every line is a certificate', () => {
    expect(orderKind([{ item_type: 'ssl' }, { item_type: 'ssl' }])).toBe('ssl')
    expect(orderKind([{ item_type: 'register' }, { item_type: 'ssl' }])).toBe('register')
  })

  it('says what is happening, what comes next, and owes refunds for live failures', () => {
    expect(orderNotice('paid', false, 'ssl', 1)?.text).toMatch(/ordering your certificate from/)
    expect(orderNotice('completed', false, 'ssl', 2)?.text).toBe(
      'Ordered. Next, set them up — open each certificate below.',
    )
    expect(orderNotice('completed', true, 'ssl', 1)?.text).toMatch(/not trusted by browsers/)
    expect(orderNotice('failed', false, 'ssl', 1)?.text).toMatch(
      /could not order this certificate.*refunded automatically/,
    )
    expect(orderNotice('partially_failed', true, 'ssl', 2)?.text).toMatch(
      /some of these certificates.*No money moved/,
    )
    expect(orderNotice('cancelled', false, 'ssl')?.text).toMatch(/closed without payment/)
    expect(orderNotice('awaiting_payment', false, 'ssl')).toBeNull()
  })

  it('labels a certificate line by ordering, not registering', () => {
    expect(lineStatus('ssl', 'provisioning')).toBe('Ordering')
    expect(lineStatus('ssl', 'completed')).toBe('Ordered')
    expect(lineStatus('ssl', 'failed')).toBe('Failed')
  })

  it('sends a cancelled or failed certificate payment back to the cart', () => {
    expect(paymentNotice('cancelled', 'ssl', 'x@y.z')?.text).toMatch(
      /Your certificates are still in your cart/,
    )
    expect(paymentNotice('failed', 'ssl', 'x@y.z')?.text).toMatch(/try again from your cart/)
    expect(paymentNotice('underpaid', 'ssl', 'x@y.z')?.text).toMatch(/nothing has been ordered/)
  })

  it('shows the order status in certificate words', () => {
    render(<OrderStatus status="provisioning" kind="ssl" />)
    expect(screen.getByText('Ordering')).toBeInTheDocument()
  })

  it('names a certificate’s refund', () => {
    expect(refundLabel({ reason: 'ssl_failed', domain: 'example.com' })).toBe(
      'SSL certificate for example.com',
    )
  })
})

describe('a receipt with a certificate (CMP-17, N8)', () => {
  it('words the line by its term and the price of a new one, never "renews at"', () => {
    expect(lineLabel('ssl', 1)).toBe('SSL certificate, 1-year subscription')
    expect(renewalText({ kind: 'ssl', renewalKobo: 1_350_000, renewalYears: 1 })).toBe(
      'a new one is ₦13,500 at today’s price',
    )
    expect(renewalText({ kind: 'register', renewalKobo: 1_870_000, renewalYears: 1 })).toBe(
      'renews at ₦18,700/yr',
    )
    const receipt = toReceipt({
      id: 'o1',
      order_number: 'ND-1',
      invoice_number: 'INV-1',
      paid_at: '2026-10-02T12:00:00Z',
      payment_id: null,
      tx_ref: 'MDH-1',
      subtotal_kobo: 1_350_000,
      vat_pct: 7.5,
      vat_kobo: 101_250,
      total_kobo: 1_451_250,
      registrant: {},
      test_mode: false,
      order_items: [
        {
          id: 'l1',
          item_type: 'ssl',
          domain: 'example.com',
          period_years: 1,
          price_kobo: 1_350_000,
          renewal_kobo: 1_350_000,
          status: 'failed',
          created_at: '2026-10-02T11:00:00Z',
        },
      ],
      payments: [],
    })
    expect(receipt?.lines[0]).toMatchObject({ kind: 'ssl', failed: true })
  })
})

describe('certificates for search engines and assistants', () => {
  it('repeats the page’s price and term as a Service, with no claim the page does not make', () => {
    const node = certificateServiceLd('https://www.mydomainshub.com', {
      productCode: '351',
      name: 'Sectigo PositiveSSL Certificate',
      priceKobo: 1_350_000,
      description: 'One name. 1-year subscription.',
    })
    expect(node).toMatchObject({
      '@type': 'Service',
      '@id': 'https://www.mydomainshub.com/ssl#ssl-351',
      serviceType: 'SSL/TLS certificate',
      offers: { price: '13500.00', priceCurrency: 'NGN' },
    })
    expect(JSON.stringify(node)).not.toMatch(/aggregateRating|warranty|valid for/i)
  })

  it('lists the certificates in llms.txt with the honest term, or not at all', () => {
    const site = 'https://www.mydomainshub.com'
    const text = llmsTxt({
      site,
      prices: null,
      certificates: [
        { name: 'Sectigo PositiveSSL Certificate', price: '₦13,500', covers: 'One name.' },
      ],
    })
    expect(text).toContain('## SSL certificates')
    expect(text).toContain(
      '[Sectigo PositiveSSL Certificate](https://www.mydomainshub.com/ssl): ₦13,500 — One name.',
    )
    expect(text).toContain('It never renews by itself.')
    expect(text).toContain('[SSL certificates](https://www.mydomainshub.com/ssl)')
    expect(llmsTxt({ site, prices: null })).not.toContain('## SSL certificates')
  })
})

describe('the facts before anyone buys (N9b)', () => {
  it('says hosts often give one free, who installs it, how long it lasts, and the refund rule', () => {
    render(<SslGuide />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Vercel, Netlify and Cloudflare')
    expect(text).toContain('You do.')
    expect(text).toContain('at most 200 days')
    expect(text).toContain('Once it is ordered it is not refundable')
    expect(text).not.toMatch(/valid for (one|1) year/i)
    expect(screen.getByRole('link', { name: 'refund policy' })).toHaveAttribute(
      'href',
      '/legal/refunds#ssl',
    )
    expect(SSL_FAQS.length).toBeGreaterThanOrEqual(6)
  })
})
