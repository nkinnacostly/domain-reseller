import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cookies } from 'next/headers'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CsvDownload } from '@/features/admin/components/money/csv-download'
import {
  MarginReport,
  MarginSection,
  marginColumns,
} from '@/features/admin/components/money/margin-section'
import { MoneyControls } from '@/features/admin/components/money/money-controls'
import { MoneySkeleton } from '@/features/admin/components/money/money-skeleton'
import { MoneyView, moneyDescription } from '@/features/admin/components/money/money-view'
import { RevenueReport, RevenueSection } from '@/features/admin/components/money/revenue-section'
import { parseMargin, parseRevenue, type RevenueBucket } from '@/features/admin/lib/money-data'
import { parseMoneyParams } from '@/features/admin/lib/money-params'
import { getMargin, getRevenue } from '@/features/admin/queries/money'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { marginAnswer, marginRow, NOW, revenueAnswer, revenueRow } from './fixtures'

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

function session(rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc'] = {}) {
  const client = sessionClient({
    rpc: {
      admin_whoami: { data: whoami({ testOnly: true, role: 'operator', label: 'e2e-1234' }) },
      admin_revenue: { data: revenueAnswer() },
      admin_margin: { data: marginAnswer() },
      ...rpc,
    },
  })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

const PARAMS = parseMoneyParams({ from: '2026-10-01', to: '2026-10-03' }, NOW)

function revenue(data: unknown = revenueAnswer()): RevenueBucket[] {
  const parsed = parseRevenue(data)
  if ('issues' in parsed) throw new Error('unparsed')
  return parsed.rows
}

function margin(data: unknown = marginAnswer()) {
  const parsed = parseMargin(data)
  if ('issues' in parsed) throw new Error('unparsed')
  return parsed.rows
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }) } as never)
})

describe('getRevenue and getMargin', () => {
  it('ask SQL for one side, the dates and the grain, as the admin', async () => {
    const client = session()
    const rows = await getRevenue('test', PARAMS)
    expect(client.rpc).toHaveBeenCalledWith('admin_revenue', {
      p_test_mode: true,
      p_grain: 'day',
      p_from: '2026-10-01',
      p_to: '2026-10-03',
    })
    expect(rows?.[0]?.netKobo).toBe(2_000_000)

    const groups = await getMargin('live', PARAMS)
    expect(client.rpc).toHaveBeenCalledWith('admin_margin', {
      p_test_mode: false,
      p_from: '2026-10-01',
      p_to: '2026-10-03',
    })
    expect(groups).toHaveLength(5)
  })

  it('are null when SQL refuses, or answers a shape it did not promise', async () => {
    session({
      admin_revenue: { error: { message: 'admin:test_admin', code: '42501' } },
      admin_margin: { error: { message: 'admin:bad_range', code: '22023' } },
    })
    expect(await getRevenue('live', PARAMS)).toBeNull()
    expect(await getMargin('live', PARAMS)).toBeNull()

    session({
      admin_revenue: { data: [{ bucket: '2026-10-01', net_kobo: 1.5 }] },
      admin_margin: { data: { rows: [] } },
    })
    expect(await getRevenue('live', PARAMS)).toBeNull()
    expect(await getMargin('live', PARAMS)).toBeNull()
  })
})

describe('sales, cash and refunds', () => {
  it('shows totals that each say their side and where VAT stands', () => {
    render(<RevenueReport rows={revenue()} side="test" params={PARAMS} now={NOW} />)
    const region = screen.getByRole('region', { name: 'Sales, cash and refunds' })
    expect(
      within(region).getByText(/^Test side · 1–3 Oct 2026 · in naira, VAT shown on its own$/),
    ).toBeVisible()
    const tiles = region.querySelectorAll('[data-total]')
    expect(tiles).toHaveLength(8)
    for (const tile of tiles) expect(tile.textContent).toMatch(/Test/)
    const net = region.querySelector('[data-total="net"]')
    expect(net?.textContent).toMatch(/Net sales.*₦30,000.*VAT excluded/)
    expect(region.querySelector('[data-total="cash"]')?.textContent).toMatch(
      /₦43,000.*VAT included/,
    )
    expect(region.querySelector('[data-total="lineRefunds"]')?.textContent).toMatch(
      /₦10,000.*VAT excluded; ₦750 VAT returned with them/,
    )
    expect(region.querySelector('[data-total="chargeRefunds"]')?.textContent).toMatch(
      /₦10,750.*no VAT.*cash in only/,
    )
  })

  it('draws net sales and cash in as named pictures, with their figures in tables', () => {
    render(<RevenueReport rows={revenue()} side="live" params={PARAMS} now={NOW} />)
    const pictures = screen.getAllByRole('img')
    expect(pictures.map((picture) => picture.getAttribute('aria-label'))).toEqual([
      'Net sales by day, VAT excluded, in naira, the live side. The figures follow in a table.',
      'Cash in by day, VAT included, in naira, the live side. The figures follow in a table.',
    ])
    // Every day is drawn, the quiet one too.
    const figures = screen.getByRole('table', {
      name: 'Net sales by day, VAT excluded, in naira, the live side',
    })
    expect(within(figures).getAllByRole('row')).toHaveLength(4)
  })

  it('tables the days with something in them, line and charge refunds in their own columns', () => {
    render(<RevenueReport rows={revenue()} side="live" params={PARAMS} now={NOW} />)
    const table = screen.getByRole('table', {
      name: 'Sales, cash and refunds by day, the live side, in naira',
    })
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers).toEqual([
      'Period',
      'Orders paid',
      'Net sales (VAT excluded)',
      'VAT collected',
      'Cash in (VAT included)',
      'Line refunds (VAT excluded)',
      'VAT returned with them',
      'Charge refunds (no VAT)',
      'Flutterwave fees',
      'Fees we absorbed',
    ])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      '1 Oct 2026',
      '3 Oct 2026',
    ])
    expect(rows[1]?.textContent).toContain('₦10,750')
    // Each period opens the orders list over its days (§9's link contract).
    expect(within(table).getByRole('link', { name: '3 Oct 2026' })).toHaveAttribute(
      'href',
      '/admin/orders?from=2026-10-03&to=2026-10-03',
    )
    expect(screen.getByText(/Days with no sales, payments or refunds are left out/)).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: /^Download CSV of sales, cash and refunds by day, the live side$/,
      }),
    ).toBeEnabled()
  })

  it('says when nothing happened in the dates, and offers a wider look', () => {
    render(
      <RevenueReport
        rows={revenue([revenueRow('2026-10-01')])}
        side="test"
        params={PARAMS}
        now={NOW}
      />,
    )
    expect(
      screen.getByText('No sales, payments or refunds on the test side in these dates.'),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Show the last 12 months' })).toHaveAttribute(
      'href',
      '/admin/money?from=2025-10-03&to=2026-10-03&grain=month',
    )
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull()
  })

  it('says when sales could not be read, with a way on', async () => {
    session({ admin_revenue: { error: { message: 'boom' } } })
    render(await RevenueSection({ side: 'live', params: PARAMS, now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("Sales couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })
})

describe('margin', () => {
  it('opens with the caption, counting the lines left out (§5.2)', async () => {
    session()
    render(await MarginSection({ side: 'live', params: PARAMS }))
    const region = screen.getByRole('region', { name: 'Margin' })
    expect(region.querySelector('[data-margin-caption]')?.textContent).toBe(
      "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout. 2 lines sold before costs were recorded are left out.",
    )
  })

  it('shows each source, the lost row and the total, and never a cost it does not have', () => {
    render(<MarginReport groups={margin()} side="test" params={PARAMS} />)
    const table = screen.getByRole('table', {
      name: 'Margin by what was sold and where its cost came from, the test side, in naira',
    })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Item',
      'Lines',
      'Costed',
      'Revenue (VAT excluded)',
      'Cost (at the rate charged)',
      'Margin',
      'Source',
    ])
    const rows = within(table).getAllByRole('row').slice(1)
    const text = rows.map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    )
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Registrations',
      'Registrations',
      'Renewals',
      'Supplier cost on failed or refunded lines',
      'Total, lines with a known cost',
    ])
    expect(text[0]).toEqual(['3', '3', '₦60,000', '₦51,000', '₦9,000', "DomainNameAPI's ledger"])
    expect(text[1]).toEqual(['2', '0', '₦38,000', 'Not known', 'Not known', 'Not costed'])
    expect(text[2]?.at(-1)).toBe('Recorded at checkout')
    expect(text[3]).toEqual(['1', '1', '₦0', '₦17,000', '-₦17,000', "DomainNameAPI's ledger"])
    expect(text[4]).toEqual(['5', '5', '₦79,000', '₦84,500', '-₦5,500', '—'])
    expect(table.querySelector('[data-margin-row="lost"]')).not.toBeNull()
    // Sold items open their orders over the same dates; the lost row, the ledger.
    const links = within(table).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Registrations', '/admin/orders?kind=register&from=2026-10-01&to=2026-10-03'],
      ['Registrations', '/admin/orders?kind=register&from=2026-10-01&to=2026-10-03'],
      ['Renewals', '/admin/orders?kind=renew&from=2026-10-01&to=2026-10-03'],
      ['Supplier cost on failed or refunded lines', '/admin/supplier/ledger'],
    ])
    expect(screen.queryByText(/Cost at the last top-up rate/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Download CSV of margin, the test side' }),
    ).toBeEnabled()
  })

  it('adds the cost at the last top-up rate, said to be an estimate, when SQL has one', () => {
    render(
      <MarginReport
        groups={margin([marginRow({ cost_topup_kobo: 1_800_000 })])}
        side="live"
        params={PARAMS}
      />,
    )
    const table = screen.getByRole('table', { name: /^Margin by what was sold/ })
    expect(
      within(table).getByRole('columnheader', { name: 'Cost at the last top-up rate' }),
    ).toBeInTheDocument()
    expect(within(table).getAllByText('₦18,000').length).toBeGreaterThan(0)
    expect(
      screen.getByText(/It is an estimate of replacing them, not what was charged\./),
    ).toBeVisible()
    expect(marginColumns(false, PARAMS).map((column) => column.key)).not.toContain('topup')
  })

  it('says when no line was paid in the dates, and when margin could not be read', () => {
    const { unmount } = render(<MarginReport groups={[]} side="live" params={PARAMS} />)
    expect(screen.getByText('No paid lines on the live side in these dates.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull()
    unmount()

    render(<MarginReport groups={null} side="live" params={PARAMS} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Margin couldn't be loaded.")
  })
})

describe('the dates and the grain', () => {
  it('links each grain over the same dates, marking the one shown (S13)', () => {
    render(<MoneyControls params={PARAMS} />)
    const grains = screen.getByRole('navigation', { name: 'Group by' })
    expect(within(grains).getByRole('link', { name: 'Day' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(grains).getByRole('link', { name: 'Week' })).not.toHaveAttribute('aria-current')
    expect(within(grains).getByRole('link', { name: 'Month' })).toHaveAttribute(
      'href',
      '/admin/money?from=2026-10-01&to=2026-10-03&grain=month',
    )
  })

  it('asks for dates in a GET form, keeping a chosen grain', () => {
    const { container, unmount } = render(<MoneyControls params={PARAMS} />)
    const form = screen.getByRole('form', { name: 'Dates' })
    expect(form).toHaveAttribute('method', 'get')
    expect(form).toHaveAttribute('action', '/admin/money')
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-01')
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-03')
    expect(container.querySelector('input[name="grain"]')).toBeNull()
    unmount()

    const chosen = render(
      <MoneyControls params={parseMoneyParams({ grain: 'week', from: '2026-09-01' }, NOW)} />,
    )
    expect(chosen.container.querySelector('input[name="grain"]')).toHaveValue('week')
  })
})

describe('the CSV button', () => {
  it('saves what the page built, with a BOM for spreadsheets', async () => {
    let blob: Blob | null = null
    URL.createObjectURL = vi.fn((value: Blob) => {
      blob = value
      return 'blob:csv'
    })
    URL.revokeObjectURL = vi.fn()
    const names: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download)
    })
    const user = userEvent.setup()
    render(<CsvDownload fileName="money-sales.csv" csv={'Side\r\nTest\r\n'} about="sales" />)
    await user.click(screen.getByRole('button', { name: 'Download CSV of sales' }))
    expect(names).toEqual(['money-sales.csv'])
    await waitFor(() => expect(blob).not.toBeNull())
    const bytes = await (blob as unknown as Blob).arrayBuffer()
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe('﻿Side\r\nTest\r\n')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv')
    click.mockRestore()
  })
})

/** Every element in a tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const props = node.props as { children?: ReactNode }
  return [node, ...elements(props.children)]
}

describe('MoneyView', () => {
  it('reads who is asking, the side and the dates, then streams each section', async () => {
    session()
    const page = await MoneyView({
      searchParams: Promise.resolve({ from: '2026-09-01', to: '2026-09-30', grain: 'week' }),
    })
    const tree = elements(page)
    const props = (type: unknown) =>
      tree.find((element) => element.type === type)?.props as Record<string, unknown>

    // A test administrator is on the test side, whatever the cookie says (D15).
    expect(props(RevenueSection)).toMatchObject({
      side: 'test',
      params: { from: '2026-09-01', to: '2026-09-30', grain: 'week', grainChosen: true },
    })
    expect(props(MarginSection)).toMatchObject({ side: 'test' })

    const header = tree.find((element) => (element.props as { title?: unknown }).title === 'Money')
    render(header as ReactElement)
    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('heading', { level: 1, name: 'Money' })).toBeVisible()
    expect(
      within(banner).getByText(
        'Sales, VAT, refunds, fees and margin on the test side, 1–30 Sept 2026, by week.',
      ),
    ).toBeVisible()
    expect(within(banner).getByRole('button', { name: 'Test' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(banner).queryByRole('status')).toBeNull()
  })

  it('says when the dates were wider than one read allows', async () => {
    session()
    const page = await MoneyView({
      searchParams: Promise.resolve({ from: '2019-01-01', to: '2026-10-03' }),
    })
    const header = elements(page).find(
      (element) => (element.props as { title?: unknown }).title === 'Money',
    )
    render(header as ReactElement)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dates are limited to 1,100 days at a time, so this starts on the earliest day allowed.',
    )
  })

  it('is a 404 for anyone SQL does not know as an admin', async () => {
    session({ admin_whoami: { error: { message: 'not_admin', code: '42501' } } })
    await expect(MoneyView({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('words the page in one line, and loads as shapes, not a spinner', () => {
    expect(moneyDescription('live', PARAMS)).toBe(
      'Sales, VAT, refunds, fees and margin on the live side, 1–3 Oct 2026, by day.',
    )
    const { container } = render(<MoneySkeleton />)
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
