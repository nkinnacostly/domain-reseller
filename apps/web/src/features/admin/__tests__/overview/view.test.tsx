import { render, screen, within } from '@testing-library/react'
import { cookies } from 'next/headers'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AttentionSection,
  BusinessSection,
  HealthSection,
  ListsSection,
  OverviewView,
} from '@/features/admin/components/overview/overview-view'
import { getOverview, getRecentPaidOrders } from '@/features/admin/queries/overview'
import { adminWhoami } from '@/features/admin/queries/session'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'
import { NOW, overviewAnswer } from './fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  },
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// React's cache() remembers one answer outside a render; each test asks afresh.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T,>(fn: T) => fn,
}))

const counts = {
  refunds: 0,
  jobs: 1,
  incidents: 0,
  alertsCritical: 0,
  alertsWarning: 0,
  drift: 0,
  stuckOrders: 0,
  pendingWithoutJob: 0,
  emailsFailed: 0,
  ledgerUnexplained: 0,
  presetDrafts: 0,
}

type Call = [string, ...unknown[]]

/** A service client whose reads record their query and answer `result`. */
function service(result: { data?: unknown; error?: unknown } = { data: [] }) {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'not', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is awaited, so the fake is a thenable too
  builder.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })
  vi.mocked(createServiceClient).mockReturnValue({
    from: (name: string) => {
      calls.push(['from', name])
      return builder
    },
  } as never)
  return calls
}

function session(rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc'] = {}) {
  const client = sessionClient({
    rpc: {
      admin_whoami: { data: whoami({ testOnly: true, role: 'operator', label: 'e2e-1234' }) },
      admin_overview: { data: overviewAnswer() },
      admin_attention_counts: { data: counts },
      ...rpc,
    },
  })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

async function principal(overrides: Record<string, unknown> = {}) {
  const client = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(client.client as never, null)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }) } as never)
})

describe('getOverview', () => {
  it('asks SQL for one side, as the admin', async () => {
    const client = session()
    const read = await getOverview('test')
    expect(client.rpc).toHaveBeenCalledWith('admin_overview', { p_test_mode: true })
    expect(read?.lines.d30.register).toBe(4)
  })

  it('is null when SQL refuses, or answers a shape it did not promise', async () => {
    session({ admin_overview: { error: { message: 'admin:test_admin', code: '42501' } } })
    expect(await getOverview('live')).toBeNull()
    session({ admin_overview: { data: { sales: 'lots' } } })
    expect(await getOverview('live')).toBeNull()
  })
})

describe('getRecentPaidOrders', () => {
  const row = {
    id: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
    order_number: 'MDH-ABC123',
    status: 'completed',
    total_kobo: 2_150_000,
    paid_at: '2026-10-03T08:00:00Z',
    invoice_number: null,
    test_mode: true,
  }

  it('reads the latest ten paid orders through admin_orders_v, on the side', async () => {
    const calls = service({ data: [row, { ...row, id: null }, { ...row, total_kobo: 1.5 }] })
    const orders = await getRecentPaidOrders(await principal(), 'test')
    expect(orders).toEqual([
      {
        id: row.id,
        orderNumber: 'MDH-ABC123',
        status: 'completed',
        totalKobo: 2_150_000,
        paidAt: row.paid_at,
        invoiceNumber: null,
        testMode: true,
      },
    ])
    expect(calls).toEqual([
      ['from', 'admin_orders_v'],
      [
        'select',
        'id, order_number, status, total_kobo, paid_at, invoice_number, test_mode',
        undefined,
      ],
      ['eq', 'test_mode', true],
      ['not', 'payment_id', 'is', null],
      ['order', 'paid_at', { ascending: false }],
      ['limit', 10],
    ])
  })

  it('keeps a test administrator on the test side, whatever is asked', async () => {
    const calls = service()
    await getRecentPaidOrders(await principal({ testOnly: true }), 'live')
    expect(calls).toContainEqual(['eq', 'test_mode', true])
  })

  it('is null when the read fails, or is refused', async () => {
    service({ error: { code: '57014', message: 'timeout' } })
    expect(await getRecentPaidOrders(await principal(), 'live')).toBeNull()
    service()
    const forged = { ...whoami() } as never
    expect(await getRecentPaidOrders(forged, 'live')).toBeNull()
  })
})

describe('the sections', () => {
  it('health: the strip, or an error with a way on', async () => {
    session()
    render(await HealthSection({ side: 'live', testOnly: false, now: NOW }))
    expect(screen.getByRole('region', { name: 'Health' })).toBeInTheDocument()

    session({ admin_overview: { error: { message: 'boom' } } })
    render(await HealthSection({ side: 'live', testOnly: false, now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("Health couldn't be loaded.")
  })

  it('needs a person: the tiles, or an error', async () => {
    session()
    const { unmount } = render(await AttentionSection({ side: 'test' }))
    expect(screen.getByRole('link', { name: /^Jobs needing a person\s+1$/ })).toBeInTheDocument()
    unmount()

    session({ admin_attention_counts: { error: { message: 'admin:test_admin' } } })
    render(await AttentionSection({ side: 'live' }))
    expect(screen.getByRole('alert')).toHaveTextContent("What needs a person couldn't be counted.")
  })

  it('business: sales, the float and the charts, or an error', async () => {
    session()
    const { unmount } = render(await BusinessSection({ side: 'live', period: 90, now: NOW }))
    expect(screen.getByRole('region', { name: 'Sales' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Supplier float' })).toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByRole('link', { name: '90 days' })).toHaveAttribute('aria-current', 'true')
    unmount()

    session({ admin_overview: { error: { message: 'boom' } } })
    render(await BusinessSection({ side: 'live', period: 30, now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Sales, the float and the charts couldn't be loaded.",
    )
  })

  it('lists: the latest orders beside the audit log', async () => {
    service({ data: [] })
    render(await ListsSection({ admin: await principal(), side: 'live' }))
    expect(screen.getByText('No paid orders on this side yet.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Audit log' })).toBeInTheDocument()
  })
})

/** Every element in a tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const props = node.props as { children?: ReactNode }
  return [node, ...elements(props.children)]
}

describe('OverviewView', () => {
  it('reads who is asking, the side and the period, then streams each section', async () => {
    session()
    const page = await OverviewView({ searchParams: Promise.resolve({ period: '7' }) })
    const tree = elements(page)
    const props = (type: unknown) =>
      tree.find((element) => element.type === type)?.props as Record<string, unknown>

    // A test administrator is on the test side, whatever the cookie says (D15).
    expect(props(HealthSection)).toMatchObject({ side: 'test', testOnly: true })
    expect(props(AttentionSection)).toMatchObject({ side: 'test' })
    expect(props(BusinessSection)).toMatchObject({ side: 'test', period: 7 })
    expect(props(ListsSection)).toMatchObject({ side: 'test' })

    const header = tree.find(
      (element) => (element.props as { title?: unknown }).title === 'Operations',
    )
    expect(header).toBeDefined()
    render(header as ReactElement)
    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
    expect(within(banner).getByText(/^It’s \w+day \d+ \w+ \d{4}$/)).toBeInTheDocument()
    expect(within(banner).getByRole('button', { name: 'Test' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('is a 404 for anyone SQL does not know as an admin', async () => {
    session({ admin_whoami: { error: { message: 'not_admin', code: '42501' } } })
    await expect(OverviewView({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    )
  })
})
