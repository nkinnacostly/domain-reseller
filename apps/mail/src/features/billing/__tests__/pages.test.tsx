import { render, screen } from '@testing-library/react'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as webhook } from '@/app/api/billing/flutterwave/route'
import { GET as complete } from '@/app/dashboard/billing/complete/route'
import type { CurrentAccount } from '@/features/accounts/queries/accounts'
import { getUsage } from '@/features/accounts/queries/overview'
import { createClient } from '@/lib/supabase/server'
import { fakeSupabase } from '../../accounts/__tests__/fake-supabase'
import { BillingPage } from '../components/billing-page'
import { InvoicePage } from '../components/invoice-page'
import { getBillingOverview, getCheckout, getInvoice, listInvoices } from '../queries/billing'
import { paymentsConfigured } from '../server/env'
import { returnFromCheckout } from '../server/return'
import { handleFlutterwaveWebhook } from '../server/webhook'
import { ACCOUNT_ID, freeOverview, INVOICE_ROW, starterOverview } from './fixtures'

/** The billing page and its routes, each part failing on its own (S11). */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../actions/billing', () => ({
  startCheckout: vi.fn(),
  scheduleChange: vi.fn(),
  keepPlan: vi.fn(),
}))
vi.mock('@/features/accounts/queries/overview', () => ({ getUsage: vi.fn() }))
vi.mock('../server/env', () => ({ paymentsConfigured: vi.fn(() => true) }))
vi.mock('../server/return', () => ({ returnFromCheckout: vi.fn() }))
vi.mock('../server/webhook', () => ({ handleFlutterwaveWebhook: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({}) }))

const USAGE = {
  day: '2026-10-06',
  monthStart: '2026-10-01',
  planCode: 'starter',
  caps: { daily: 1000, monthly: 50_000 },
  today: { queued: 10, sent: 10, delivered: 9, bounced: 1, complained: 0, failed: 0 },
  month: { queued: 400, sent: 400, delivered: 390, bounced: 5, complained: 0, failed: 0 },
}

function current(role: 'owner' | 'viewer', state: 'active' | 'paused' = 'active'): CurrentAccount {
  const account = {
    id: ACCOUNT_ID,
    name: 'Acme',
    state,
    sesStatus: 'enabled',
    planCode: 'starter',
    website: null,
    useCase: null,
    expectedMonthlyVolume: null,
    createdAt: '2026-10-01T00:00:00Z',
  }
  return {
    user: { id: 'u' } as never,
    memberships: [{ role, account }],
    current: { role, account },
  }
}

function session(answers: Parameters<typeof fakeSupabase>[0]) {
  const fake = fakeSupabase(answers)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.mocked(paymentsConfigured).mockReturnValue(true)
  vi.mocked(getUsage).mockResolvedValue(USAGE)
})

describe('the billing page', () => {
  it('shows the plan, its use, the plans and the invoices to an owner', async () => {
    session({
      rpc: { billing_overview: () => ({ data: starterOverview(), error: null }) },
      tables: { invoices: { rows: { data: [INVOICE_ROW], error: null } } },
    })
    render(await BillingPage({ data: current('owner'), payment: 'paid' }))
    expect(screen.getByRole('heading', { name: 'Billing', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/Payment received/)).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'This month' })).toHaveAttribute('max', '50000')
    expect(screen.getByRole('link', { name: 'MDM-TEST-INV-000042' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /move to Pro now/ })).toBeInTheDocument()
  })

  it('a viewer sees the plans without buttons, and no invoices', async () => {
    session({
      rpc: {
        billing_overview: () => ({
          data: starterOverview({ role: 'viewer', canManage: false }),
          error: null,
        }),
      },
    })
    render(await BillingPage({ data: current('viewer'), payment: undefined }))
    expect(screen.getByText(/Only the account’s owner or an admin/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Invoices' })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says paid plans are not on sale yet, and a paused account cannot change', async () => {
    vi.mocked(paymentsConfigured).mockReturnValue(false)
    session({ rpc: { billing_overview: () => ({ data: freeOverview(), error: null }) } })
    const { unmount } = render(await BillingPage({ data: current('owner'), payment: undefined }))
    expect(screen.getByText(/Paid plans are not on sale yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    unmount()
    vi.mocked(paymentsConfigured).mockReturnValue(true)
    render(await BillingPage({ data: current('owner', 'paused'), payment: undefined }))
    expect(screen.getByText(/This account is paused/)).toBeInTheDocument()
  })

  it('each part that cannot load says so, with a way to try again', async () => {
    vi.mocked(getUsage).mockResolvedValue(null)
    session({
      rpc: { billing_overview: () => ({ data: null, error: { code: '08006' } }) },
      tables: { invoices: { rows: { data: null, error: { code: '08006' } } } },
    })
    render(await BillingPage({ data: current('owner'), payment: undefined }))
    for (const what of ['your plan', 'this month’s use', 'the plans', 'the invoices']) {
      expect(screen.getByText(`We couldn’t load ${what}`)).toBeInTheDocument()
    }
  })
})

describe('the invoice page', () => {
  it('shows an invoice the person may see', async () => {
    session({ tables: { invoices: { single: { data: INVOICE_ROW, error: null } } } })
    render(await InvoicePage({ id: INVOICE_ROW.id }))
    expect(screen.getByRole('heading', { name: 'Receipt', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeInTheDocument()
  })

  it('the same "not found" for another account’s invoice and for nonsense; an error says so', async () => {
    session({ tables: { invoices: { single: { data: null, error: null } } } })
    const { unmount } = render(await InvoicePage({ id: INVOICE_ROW.id }))
    expect(screen.getByRole('heading', { name: 'Invoice not found' })).toBeInTheDocument()
    unmount()
    const again = render(await InvoicePage({ id: 'nonsense' }))
    expect(screen.getByRole('heading', { name: 'Invoice not found' })).toBeInTheDocument()
    again.unmount()
    session({ tables: { invoices: { single: { data: null, error: { code: '08006' } } } } })
    render(await InvoicePage({ id: INVOICE_ROW.id }))
    expect(screen.getByText('We couldn’t load this invoice')).toBeInTheDocument()
  })
})

describe('billing reads, as the person', () => {
  it('reads the overview, invoices, an invoice and a checkout through RLS', async () => {
    const fake = session({
      rpc: { billing_overview: () => ({ data: freeOverview(), error: null }) },
      tables: {
        invoices: { rows: { data: [INVOICE_ROW, { odd: true }], error: null } },
        checkouts: {
          single: {
            data: { id: 'c', account_id: ACCOUNT_ID, tx_ref: 'MDM-x', status: 'open' },
            error: null,
          },
        },
      },
    })
    expect((await getBillingOverview(`${ACCOUNT_ID}-a`))?.plan?.code).toBe('free')
    expect(await listInvoices(ACCOUNT_ID)).toHaveLength(1)
    expect(await getCheckout('7f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f')).toEqual({
      id: 'c',
      accountId: ACCOUNT_ID,
      txRef: 'MDM-x',
      status: 'open',
    })
    expect(await getCheckout('nope')).toBeNull()
    expect(await getInvoice('nope')).toBeNull()
    expect(fake.calls.some((c) => c.table === 'invoices' && c.method === 'order')).toBe(true)
  })

  it('asks once more when a read never reached the database, but not after a refusal', async () => {
    let calls = 0
    session({
      rpc: {
        billing_overview: () => {
          calls += 1
          return calls === 1
            ? { data: null, error: { code: '', message: 'TypeError: fetch failed' } }
            : { data: freeOverview(), error: null }
        },
      },
    })
    expect((await getBillingOverview(`${ACCOUNT_ID}-c`))?.plan?.code).toBe('free')
    expect(calls).toBe(2)
    calls = 0
    session({
      rpc: {
        billing_overview: () => {
          calls += 1
          return { data: null, error: { code: '42501', message: 'denied' } }
        },
      },
    })
    expect(await getBillingOverview(`${ACCOUNT_ID}-d`)).toBeNull()
    expect(calls).toBe(1)
  })

  it('answers null when a read fails', async () => {
    session({
      rpc: { billing_overview: () => ({ data: null, error: { code: '08006' } }) },
      tables: {
        invoices: { rows: { data: null, error: { code: '08006' } } },
        checkouts: { single: { data: null, error: { code: '08006' } } },
      },
    })
    expect(await getBillingOverview(`${ACCOUNT_ID}-b`)).toBeNull()
    expect(await listInvoices(ACCOUNT_ID)).toBeNull()
    expect(await getCheckout('7f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f')).toBeNull()
  })
})

describe('the routes', () => {
  it('the return from Flutterwave lands on Billing with what happened', async () => {
    session({
      tables: {
        checkouts: {
          single: {
            data: { id: 'c', account_id: ACCOUNT_ID, tx_ref: 'MDM-x', status: 'open' },
            error: null,
          },
        },
      },
    })
    vi.mocked(returnFromCheckout).mockResolvedValue('paid')
    const response = await complete(
      new NextRequest(
        'http://mail.test/dashboard/billing/complete?checkout=7f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f&status=successful&transaction_id=9',
      ),
    )
    expect(response.headers.get('location')).toBe('http://mail.test/dashboard/billing?payment=paid')
    expect(returnFromCheckout).toHaveBeenCalledWith(
      { id: 'c', accountId: ACCOUNT_ID, txRef: 'MDM-x', status: 'open' },
      { status: 'successful', transactionId: '9' },
    )
    vi.mocked(returnFromCheckout).mockResolvedValue(null)
    const none = await complete(new NextRequest('http://mail.test/dashboard/billing/complete'))
    expect(none.headers.get('location')).toBe('http://mail.test/dashboard/billing')
  })

  it('the webhook answers with the handler’s status', async () => {
    vi.mocked(handleFlutterwaveWebhook).mockResolvedValue({
      status: 503,
      body: { ok: false, retry: true },
    })
    const response = await webhook(
      new NextRequest('http://mail.test/api/billing/flutterwave', {
        method: 'POST',
        headers: { 'verif-hash': 'h' },
        body: '{"event":"charge.completed"}',
      }),
    )
    expect(response.status).toBe(503)
    expect(handleFlutterwaveWebhook).toHaveBeenCalledWith('h', '{"event":"charge.completed"}')
  })
})
