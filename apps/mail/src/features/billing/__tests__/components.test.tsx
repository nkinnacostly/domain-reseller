import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keepPlan, scheduleChange, startCheckout } from '../actions/billing'
import { CurrentPlan } from '../components/current-plan'
import { InvoiceDocument } from '../components/invoice-document'
import { InvoiceList } from '../components/invoice-list'
import { type PlanCard, PlanOptions } from '../components/plan-options'
import { PrintButton } from '../components/print-button'
import { readInvoice, readInvoiceSummary } from '../lib/invoice'
import { type BillingOverview, readBillingOverview } from '../lib/overview'
import { capsText, optionCopy, priceText } from '../lib/plan-copy'
import {
  ACCOUNT_ID,
  freeOverview,
  INVOICE_ROW,
  planRow,
  starterOverview,
  subscription,
} from './fixtures'

/** The billing page's parts (MAIL-SPEC §8, §10): words, states, and what each button sends. */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard/billing',
}))
vi.mock('../actions/billing', () => ({
  startCheckout: vi.fn(),
  scheduleChange: vi.fn(),
  keepPlan: vi.fn(),
}))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

function overview(value: unknown): BillingOverview {
  const read = readBillingOverview(value)
  if (!read) throw new Error('fixture')
  return read
}

function cards(value: BillingOverview): PlanCard[] {
  return value.plans.map((option) => ({
    code: option.code,
    name: option.name,
    price: priceText(option),
    caps: capsText(option),
    copy: optionCopy(option, value),
  }))
}

beforeEach(() => vi.clearAllMocks())

describe('PlanOptions', () => {
  it('pays through Flutterwave: the total SQL quoted, a pressed state, then the hosted page', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { assign }, writable: true })
    answer(startCheckout, { data: { redirectTo: 'https://checkout.test/pay/1' } })
    render(<PlanOptions accountId={ACCOUNT_ID} plans={cards(overview(freeOverview()))} canAct />)
    const starter = screen.getByText('Starter').closest('li') as HTMLElement
    expect(within(starter).getByText('₦20,000 a month + 7.5% VAT')).toBeInTheDocument()
    expect(within(starter).getByText('50,000 emails a month, 5,000 a day')).toBeInTheDocument()
    await userEvent.click(
      within(starter).getByRole('button', { name: 'Pay ₦21,500 and start Starter' }),
    )
    expect(startCheckout).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      planCode: 'starter',
      expectedTotalKobo: 2_150_000,
    })
    expect(
      await within(starter).findByRole('button', { name: /Opening Flutterwave/ }),
    ).toBeDisabled()
    expect(assign).toHaveBeenCalledWith('https://checkout.test/pay/1')
  })

  it('shows a refusal in place, and no buttons for those who cannot act', async () => {
    answer(startCheckout, { data: { error: 'The price changed since this page loaded.' } })
    const { unmount } = render(
      <PlanOptions accountId={ACCOUNT_ID} plans={cards(overview(freeOverview()))} canAct />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Pay ₦21,500 and start Starter' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The price changed')
    unmount()
    render(
      <PlanOptions accountId={ACCOUNT_ID} plans={cards(overview(freeOverview()))} canAct={false} />,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Your plan')).toBeInTheDocument()
  })

  it('a cancellation is asked once more, with what it means, then the page refreshes', async () => {
    answer(scheduleChange, { data: { ok: true } })
    render(<PlanOptions accountId={ACCOUNT_ID} plans={cards(overview(starterOverview()))} canAct />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel and move to Free on 6 November 2026' }),
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel Starter?' })
    expect(dialog).toHaveTextContent('its card charges stop now')
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel and move to Free on 6 November 2026' }),
    )
    expect(scheduleChange).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, planCode: 'free' })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('keeps the dialog open with the refusal while it is refused', async () => {
    answer(scheduleChange, { data: { error: 'We could not confirm the change with Flutterwave.' } })
    render(<PlanOptions accountId={ACCOUNT_ID} plans={cards(overview(starterOverview()))} canAct />)
    await userEvent.click(screen.getByRole('button', { name: /^Cancel and move to Free/ }))
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^Cancel and move to Free/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not confirm')
    expect(router.refresh).not.toHaveBeenCalled()
  })
})

describe('CurrentPlan', () => {
  it('a Free account: nothing charged, no card', () => {
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(freeOverview())} canAct />)
    const plan = screen.getByRole('region', { name: 'Your plan' })
    expect(plan).toHaveTextContent('Free')
    expect(plan).toHaveTextContent('No card payments')
    expect(plan).toHaveTextContent('Nothing is charged on this plan')
  })

  it('an active plan: its price with VAT, its period, and the card by its last four', () => {
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(starterOverview())} canAct />)
    const plan = screen.getByRole('region', { name: 'Your plan' })
    expect(plan).toHaveTextContent('₦21,500 a month: ₦20,000 plus 7.5% VAT')
    expect(plan).toHaveTextContent('Paid for 6 October 2026 – 6 November 2026')
    expect(plan).toHaveTextContent('Card on file: Visa ending 4242')
    expect(plan).toHaveTextContent('Test payments')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('hides the card from those who do not manage billing', () => {
    render(
      <CurrentPlan
        accountId={ACCOUNT_ID}
        overview={overview(starterOverview({ canManage: false, role: 'viewer' }))}
        canAct={false}
      />,
    )
    expect(screen.queryByText(/Card on file/)).toBeNull()
  })

  it('a scheduled change: when it happens, and a way to keep the plan', async () => {
    answer(keepPlan, { data: { ok: true } })
    const scheduled = starterOverview({
      subscription: subscription({ scheduledPlanCode: 'free', scheduledPlanName: 'Free' }),
    })
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(scheduled)} canAct />)
    const plan = screen.getByRole('region', { name: 'Your plan' })
    expect(plan).toHaveTextContent('Change scheduled')
    expect(plan).toHaveTextContent('On 6 November 2026 the account moves to the Free plan.')
    await userEvent.click(screen.getByRole('button', { name: 'Keep Starter' }))
    expect(keepPlan).toHaveBeenCalledWith({ accountId: ACCOUNT_ID })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('a downgrade to a paid plan says it needs a new card payment', () => {
    const scheduled = starterOverview({
      subscription: subscription({
        planCode: 'pro',
        planName: 'Pro',
        scheduledPlanCode: 'starter',
        scheduledPlanName: 'Starter',
      }),
    })
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(scheduled)} canAct />)
    expect(screen.getByRole('region', { name: 'Your plan' })).toHaveTextContent(
      'moves to the Starter plan, which needs a new card payment',
    )
  })

  it('keeping the plan shows a pending state and any refusal', async () => {
    hang(keepPlan)
    const scheduled = starterOverview({
      subscription: subscription({ scheduledPlanCode: 'free', scheduledPlanName: 'Free' }),
    })
    const { unmount } = render(
      <CurrentPlan accountId={ACCOUNT_ID} overview={overview(scheduled)} canAct />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Keep Starter' }))
    expect(screen.getByRole('button', { name: /Keeping Starter/ })).toBeDisabled()
    unmount()
    answer(keepPlan, { data: { error: 'No change is scheduled.' } })
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(scheduled)} canAct />)
    await userEvent.click(screen.getByRole('button', { name: 'Keep Starter' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No change is scheduled.')
  })

  it('past due: by reason, with the date sending stops', () => {
    const due = (reason: string) =>
      starterOverview({
        subscription: subscription({
          status: 'past_due',
          pastDueReason: reason,
          pastDueSince: '2026-11-06T10:00:00Z',
          pastDueUntil: '2026-11-13T10:00:00Z',
        }),
        plans: [planRow('free', 'none'), planRow('starter', 'pay')],
      })
    const { unmount } = render(
      <CurrentPlan accountId={ACCOUNT_ID} overview={overview(due('renewal_failed'))} canAct />,
    )
    const plan = screen.getByRole('region', { name: 'Your plan' })
    expect(plan).toHaveTextContent('Past due')
    expect(plan).toHaveTextContent(
      'The renewal payment due on 6 November 2026 has not come through',
    )
    expect(plan).toHaveTextContent('Sending continues until 13 November 2026')
    unmount()
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(due('payment_needed'))} canAct />)
    expect(screen.getByRole('region', { name: 'Your plan' })).toHaveTextContent(
      'A change of plan needs a new card payment',
    )
  })

  it('an ended plan says how it ended', () => {
    const ended = freeOverview({
      subscription: subscription({ status: 'ended', endedReason: 'lapsed' }),
    })
    render(<CurrentPlan accountId={ACCOUNT_ID} overview={overview(ended)} canAct />)
    expect(screen.getByRole('region', { name: 'Your plan' })).toHaveTextContent(
      'The Starter plan ended after its payment was past due.',
    )
  })
})

describe('invoices', () => {
  it('lists them, test ones marked, each linking to its page; none says so', () => {
    const summary = readInvoiceSummary(INVOICE_ROW)
    if (!summary) throw new Error('fixture')
    const { unmount } = render(<InvoiceList invoices={[summary]} />)
    const link = screen.getByRole('link', { name: 'MDM-TEST-INV-000042' })
    expect(link).toHaveAttribute('href', `/dashboard/billing/invoices/${INVOICE_ROW.id}`)
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(screen.getByText('₦44,791.67')).toBeInTheDocument()
    unmount()
    render(<InvoiceList invoices={[]} />)
    expect(screen.getByText(/No invoices yet/)).toBeInTheDocument()
  })

  it('a test payment’s receipt says it is not a tax invoice; a live one is one, with CAC and TIN', () => {
    const invoice = readInvoice(INVOICE_ROW)
    if (!invoice) throw new Error('fixture')
    const { unmount } = render(<InvoiceDocument invoice={invoice} />)
    expect(screen.getByRole('heading', { name: 'Receipt', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Test payment — not a tax invoice.')).toBeInTheDocument()
    unmount()
    render(
      <InvoiceDocument
        invoice={{ ...invoice, testMode: false, number: 'MDM-INV-000001', method: null }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Tax invoice', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/RC 9771867/)).toBeInTheDocument()
    expect(screen.getByText(/TIN 2622401595060/)).toBeInTheDocument()
    expect(screen.getByText('−₦13,333.33')).toBeInTheDocument()
    expect(screen.getByText('VAT (7.5%)')).toBeInTheDocument()
    expect(screen.getByText('Flutterwave')).toBeInTheDocument()
  })

  it('prints', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<PrintButton />)
    await userEvent.click(screen.getByRole('button', { name: 'Print or save as PDF' }))
    expect(print).toHaveBeenCalled()
  })
})
