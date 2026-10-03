import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { LineChart } from '@/features/admin/components/charts/line-chart'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DiffTable } from '@/features/admin/components/diff-table'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { StatTile } from '@/features/admin/components/stat-tile'
import { DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { TableToolbar } from '@/features/admin/components/table/table-toolbar'
import { Timeline } from '@/features/admin/components/timeline'
import { REFUND_STATUS_LABEL } from '@/features/admin/lib/labels'

const refresh = vi.fn()
let pathname = '/admin/refunds'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => pathname,
}))

beforeEach(() => vi.clearAllMocks())

type Row = { id: string; order: string; total: string; status: string }
const rows: Row[] = [
  { id: 'a', order: 'MDH-1', total: '₦10,000', status: 'held' },
  { id: 'b', order: 'MDH-2', total: '₦5,000', status: 'completed' },
]

describe('DataTable', () => {
  const columns = [
    { key: 'order', header: 'Order', cell: (row: Row) => row.order },
    {
      key: 'total',
      header: 'Total',
      cell: (row: Row) => row.total,
      sort: 'total' as const,
      numeric: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row: Row) => <AdminStatusPill value={row.status} labels={REFUND_STATUS_LABEL} />,
      sort: 'status' as const,
    },
  ]

  it('is a captioned table with scoped headers, and a card list for narrow screens', () => {
    render(
      <DataTable
        caption="Refunds"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        empty={<EmptyState title="No refunds" />}
      />,
    )
    const table = screen.getByRole('table', { name: 'Refunds' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.getAttribute('scope')),
    ).toEqual(['col', 'col', 'col'])
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((th) => th.textContent),
    ).toEqual(['MDH-1', 'MDH-2'])
    expect(table.parentElement).toHaveClass('relative', 'overflow-x-auto')
    // A scroll box a keyboard reaches and a screen reader names (axe scrollable-region-focusable).
    const box = screen.getByRole('region', { name: 'Refunds' })
    expect(box).toBe(table.parentElement)
    expect(box).toHaveAttribute('tabindex', '0')
    const cards = screen.getByRole('list', { name: 'Refunds' })
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2)
    expect(within(cards).getAllByText('Held for approval')).toHaveLength(1)
  })

  it('sorts by links and marks the sorted column with aria-sort', () => {
    render(
      <DataTable
        caption="Refunds"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        sorting={{ sort: 'total', dir: 'asc', href: (sort) => `/admin/refunds?sort=${sort}` }}
        empty={null}
      />,
    )
    const headers = screen.getAllByRole('columnheader')
    expect(headers[0]).not.toHaveAttribute('aria-sort')
    expect(headers[1]).toHaveAttribute('aria-sort', 'ascending')
    expect(headers[2]).toHaveAttribute('aria-sort', 'none')
    expect(within(headers[1] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/admin/refunds?sort=total',
    )
    expect(within(headers[1] as HTMLElement).getByRole('link')).toHaveAccessibleName(
      'Total (sorted ascending; select to reverse)',
    )
  })

  it('shows the empty state when there are no rows', () => {
    render(
      <DataTable
        caption="Refunds"
        rows={[]}
        columns={columns}
        rowKey={(row) => row.id}
        empty={<EmptyState title="Nothing is held." body="Refunds over a limit wait here." />}
      />,
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('Nothing is held.')).toBeInTheDocument()
  })
})

describe('chips and tabs change colour at once', () => {
  // Only the press animates: a colour fading in after a click is read half-way (axe did).
  const fades = (element: Element) =>
    element.className.split(/\s+/).some((name) => /^transition(-colors|-all)?$/.test(name))

  it('in FilterChips', () => {
    render(
      <FilterChips
        label="Status"
        chips={[{ value: 'held', label: 'Held' }]}
        selected={['held']}
        href={(value) => `/admin/refunds?status=${value}`}
        allHref="/admin/refunds"
      />,
    )
    for (const link of screen.getAllByRole('link')) {
      expect(fades(link), link.textContent ?? '').toBe(false)
      expect(link.className).toContain('transition-transform')
    }
  })

  it('in RouteTabs', () => {
    pathname = '/admin/emails'
    render(
      <RouteTabs
        label="Email views"
        tabs={[
          { href: '/admin/emails', label: 'Outbox', current: true },
          { href: '/admin/emails?tab=compliance', label: 'Compliance notices', current: false },
        ]}
      />,
    )
    for (const link of screen.getAllByRole('link')) expect(fades(link)).toBe(false)
  })
})

describe('FilterChips', () => {
  it('links each chip, marks the chosen ones in words and with aria-current, and counts inside the name', () => {
    render(
      <FilterChips
        label="Status"
        chips={[
          { value: 'held', label: 'Held', count: 3 },
          { value: 'failed', label: 'Failed' },
        ]}
        selected={['held']}
        href={(value) => `/admin/refunds?status=${value}`}
        allHref="/admin/refunds"
      />,
    )
    const nav = screen.getByRole('navigation', { name: 'Status' })
    expect(within(nav).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current')
    const held = within(nav).getByRole('link', { name: 'Held (3)' })
    expect(held).toHaveAttribute('aria-current', 'true')
    expect(held).toHaveAttribute('href', '/admin/refunds?status=held')
    expect(within(nav).getByRole('link', { name: 'Failed' })).not.toHaveAttribute('aria-current')
  })

  it('marks All when nothing is chosen', () => {
    render(<FilterChips label="Status" chips={[]} selected={[]} href={() => '#'} allHref="/x" />)
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true')
  })
})

describe('Pager', () => {
  it('links to the pages either side and says where you are', () => {
    render(
      <Pager page={2} pageCount={3} total={60} href={(page) => `/admin/orders?page=${page}`} />,
    )
    expect(screen.getByText('Page 2 of 3 · 60 in all')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/admin/orders?page=1',
    )
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/admin/orders?page=3',
    )
  })

  it('disables what cannot be followed, and is a count for one page', () => {
    const { rerender } = render(<Pager page={1} pageCount={2} total={30} href={() => '#'} />)
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull()
    rerender(<Pager page={1} pageCount={1} total={4} href={() => '#'} />)
    expect(screen.getByText('4 in all')).toBeInTheDocument()
    rerender(<Pager page={2} pageCount={2} total={30} href={() => '#'} />)
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
  })
})

describe('charts', () => {
  const data = [
    { key: '1', label: '1 Oct', value: 1200 },
    { key: '2', label: '2 Oct', value: 3400 },
  ]

  it('names the bar chart as an image and gives its figures as a table', () => {
    render(
      <BarChart
        title="Net sales by day"
        data={data}
        format={(value) => `₦${value}`}
        threshold={{ value: 2000, label: 'alert level' }}
      />,
    )
    expect(
      screen.getByRole('img', { name: 'Net sales by day. The figures follow in a table.' }),
    ).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Net sales by day' })
    expect(within(table).getByRole('rowheader', { name: '2 Oct' })).toBeInTheDocument()
    expect(within(table).getByText('₦3400')).toBeInTheDocument()
    expect(screen.getByText(/dashed: alert level/)).toBeInTheDocument()
  })

  it('breaks the line at a gap and says "No data" for it', () => {
    const { container } = render(
      <LineChart
        title="Balance at close"
        data={[
          { key: '1', label: '1 Oct', value: 4000 },
          { key: '2', label: '2 Oct', value: null },
          { key: '3', label: '3 Oct', value: 3000 },
          { key: '4', label: '4 Oct', value: 2500 },
        ]}
        threshold={{ value: 1000, label: 'alert' }}
      />,
    )
    expect(container.querySelectorAll('path')).toHaveLength(2)
    expect(screen.getByText('No data')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Balance at close/ })).toBeInTheDocument()
  })
})

describe('small parts', () => {
  it('pills a state in words with a tone', () => {
    render(
      <AdminStatusPill value="needs_attention" labels={{ needs_attention: 'Needs a person' }} />,
    )
    expect(screen.getByText('Needs a person')).toHaveAttribute('data-tone', 'danger')
    render(<TestBadge />)
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('puts a tile figure inside its link name', () => {
    render(
      <StatTile
        label="Refunds needing a person"
        value={3}
        hint="Oldest 2 h"
        href="/admin/refunds"
        tone="danger"
      />,
    )
    expect(
      screen.getByRole('link', { name: 'Refunds needing a person 3 Oldest 2 h' }),
    ).toHaveAttribute('href', '/admin/refunds')
    render(<StatTile label="Orders" value="12" />)
    expect(screen.getByText('Orders')).toBeInTheDocument()
  })

  it('lists facts, events and differences', () => {
    render(
      <DlGrid
        items={[
          { label: 'Order', value: 'MDH-1' },
          { label: 'Invoice', value: null, wide: true },
        ]}
      />,
    )
    expect(screen.getByText('MDH-1')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()

    render(
      <Timeline
        events={[
          { id: '1', at: '2026-10-02T13:05:00Z', title: 'Refund held', detail: 'Over the limit' },
        ]}
      />,
    )
    expect(screen.getByText('2 Oct 2026, 14:05 WAT')).toBeInTheDocument()
    render(<Timeline events={[]} empty="No events." />)
    expect(screen.getByText('No events.')).toBeInTheDocument()

    render(
      <DiffTable
        caption="Ours against the registry"
        rows={[
          { label: 'Expiry', ours: '2027-01-01', theirs: '2027-01-01', differs: false },
          { label: 'Lock', ours: 'On', theirs: 'Off', differs: true },
        ]}
      />,
    )
    const diff = screen.getByRole('table', { name: 'Ours against the registry' })
    expect(within(diff).getByText('Differs')).toBeInTheDocument()
    expect(within(diff).getByText('Same')).toBeInTheDocument()
  })

  it('offers a way on from an error, refreshing by default', async () => {
    const user = userEvent.setup()
    render(<ErrorState />)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()

    const retry = vi.fn()
    render(<ErrorState title="Failed" retry={retry} />)
    await user.click(screen.getAllByRole('button', { name: 'Try again' })[1] as HTMLElement)
    expect(retry).toHaveBeenCalled()
  })

  it('marks the current tab', () => {
    pathname = '/admin/customers/x/orders'
    render(
      <RouteTabs
        label="Customer"
        tabs={[
          { href: '/admin/customers/x', label: 'Overview', exact: true },
          { href: '/admin/customers/x/orders', label: 'Orders', count: 2 },
        ]}
      />,
    )
    expect(screen.getByRole('link', { name: 'Orders (2)' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    // A tick as well as colour (S13).
    expect(screen.getByRole('link', { name: 'Orders (2)' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Overview' }).querySelector('svg')).toBeNull()
  })

  it('marks the tab the page names when tabs share a path and differ by ?tab=', () => {
    pathname = '/admin/emails'
    render(
      <RouteTabs
        label="Email views"
        tabs={[
          { href: '/admin/emails', label: 'Outbox', current: false },
          { href: '/admin/emails?tab=compliance', label: 'Compliance notices', current: true },
        ]}
      />,
    )
    const open = screen.getByRole('link', { name: 'Compliance notices' })
    expect(open).toHaveAttribute('aria-current', 'page')
    expect(open).toHaveAttribute('data-current', 'true')
    expect(open.querySelector('svg')).not.toBeNull()
    // The path alone would have marked the outbox; the page's word wins.
    expect(screen.getByRole('link', { name: 'Outbox' })).not.toHaveAttribute('aria-current')
  })

  it('copies an id and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<CopyValue value="0f0e0d0c" label="order id" />)
    await user.click(screen.getByRole('button', { name: 'Copy order id' }))
    expect(writeText).toHaveBeenCalledWith('0f0e0d0c')
    expect(await screen.findByText('order id copied')).toBeInTheDocument()
  })

  it('searches by GET, keeping the filters', () => {
    render(
      <TableToolbar
        action="/admin/orders"
        label="Search orders"
        placeholder="Order number"
        keep={{ status: 'paid', from: undefined }}
      />,
    )
    const box = screen.getByRole('searchbox', { name: 'Search orders' })
    const form = box.closest('form') as HTMLFormElement
    expect(form).toHaveAttribute('method', 'get')
    expect(form.querySelector('input[type="hidden"][name="status"]')).toHaveValue('paid')
    expect(form.querySelector('input[name="from"]')).toBeNull()
  })

  it('pulses while loading', () => {
    const { container } = render(<TableSkeleton rows={3} />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4)
  })
})
