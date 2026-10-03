import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCustomerListParams } from '@/features/admin/lib/customers-params'
import {
  CustomersReadError,
  getCustomer,
  getCustomerStats,
  LINE_ORDERS_CAP,
  listCustomerLines,
  listCustomerOrders,
  listCustomers,
  sslProductNames,
} from '@/features/admin/queries/customers'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient } from '../foundation/fixtures'
import {
  customerJson,
  customerRow,
  fakeService,
  filterOf,
  ids,
  principal,
  type Read,
} from './fake-db'

/**
 * The customers reads (ADMIN-SPEC §5.2 B8): who a customer is comes only
 * from the admin_* functions, masked; their orders and lines through
 * adminDb, by user id, on the side shown. A test admin is kept to the Test
 * side and to e2e accounts — and is not asked SQL for totals SQL refuses.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

type Rpc = NonNullable<Parameters<typeof sessionClient>[0]>['rpc']

function session(rpc: Rpc = {}) {
  const client = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

const byTable = (reads: Read[], table: string) => reads.filter((read) => read.table === table)

beforeEach(() => vi.clearAllMocks())

describe('getCustomerStats', () => {
  it('does not ask SQL for a test admin, whom it would refuse', async () => {
    const rpc = session()
    expect(await getCustomerStats(await principal({ testOnly: true, role: 'operator' }))).toEqual({
      kind: 'hidden',
    })
    expect(rpc.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')).toEqual([])
  })

  it('reads the totals for anyone else', async () => {
    const admin = await principal()
    session({
      admin_customer_stats: {
        data: {
          profiles: 7,
          confirmed: 6,
          liveBuyers: 2,
          mfaUsers: 1,
          holders: 2,
          active30d: 5,
          over10NoMfa: 0,
          signupsByDay: [],
        },
      },
    })
    expect(await getCustomerStats(admin)).toMatchObject({ kind: 'ok', stats: { profiles: 7 } })
  })

  it('says it could not read them, on an error or an answer it cannot read', async () => {
    const admin = await principal()
    session({ admin_customer_stats: { error: { message: 'boom', code: '57014' } } })
    expect(await getCustomerStats(admin)).toEqual({ kind: 'error' })
    session({ admin_customer_stats: { data: 'seven' } })
    expect(await getCustomerStats(admin)).toEqual({ kind: 'error' })
  })
})

describe('listCustomers', () => {
  it('asks SQL for one page, sorted and filtered there', async () => {
    const admin = await principal()
    const rpc = session({ admin_customers: { data: [customerRow({ total_count: 41 })] } })
    const list = await listCustomers(
      admin,
      'live',
      parseCustomerListParams({ sort: 'paid', dir: 'asc', page: '2', per: '50', twofa: 'off' }),
    )
    expect(rpc.rpc).toHaveBeenCalledWith('admin_customers', {
      p_test_mode: false,
      p_sort: 'paid',
      p_dir: 'asc',
      p_offset: 50,
      p_limit: 50,
      p_filter: { hasTotp: false },
    })
    expect(list.total).toBe(41)
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ userId: ids.user, maskedEmail: 'a•••@gmail.com' })
  })

  it('keeps a test admin on the Test side whatever was asked (D15)', async () => {
    const admin = await principal({ testOnly: true, role: 'operator' })
    const rpc = session({ admin_customers: { data: [] } })
    expect(await listCustomers(admin, 'live', parseCustomerListParams({}))).toEqual({
      rows: [],
      total: 0,
    })
    expect(rpc.rpc).toHaveBeenCalledWith(
      'admin_customers',
      expect.objectContaining({ p_test_mode: true }),
    )
  })

  it('throws a read error, logging the code alone', async () => {
    const admin = await principal()
    session({ admin_customers: { error: { message: 'someone@example.com', code: '57014' } } })
    await expect(listCustomers(admin, 'live', parseCustomerListParams({}))).rejects.toBeInstanceOf(
      CustomersReadError,
    )
  })
})

describe('getCustomer', () => {
  it('reads the masked account on the side shown', async () => {
    const admin = await principal()
    const rpc = session({ admin_customer: { data: customerJson() } })
    const lookup = await getCustomer(admin, 'test', ids.user.toUpperCase())
    expect(rpc.rpc).toHaveBeenCalledWith('admin_customer', {
      p_user_id: ids.user,
      p_test_mode: true,
    })
    expect(lookup).toMatchObject({ kind: 'ok', customer: { userId: ids.user } })
  })

  it('does not ask SQL about something that is not an id', async () => {
    const admin = await principal()
    const rpc = session()
    expect(await getCustomer(admin, 'live', 'someone@example.com')).toEqual({ kind: 'not_found' })
    expect(rpc.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')).toEqual([])
  })

  it('says there is no such account when SQL finds none', async () => {
    const admin = await principal()
    session({ admin_customer: { data: null } })
    expect(await getCustomer(admin, 'live', ids.user)).toEqual({ kind: 'not_found' })
  })

  it('says a test admin may not see a real account (D15)', async () => {
    const admin = await principal({ testOnly: true, role: 'operator' })
    const rpc = session({ admin_customer: { error: { message: 'admin:test_admin' } } })
    expect(await getCustomer(admin, 'live', ids.user)).toEqual({ kind: 'test_admin' })
    // Asked on the Test side, as SQL requires of a test admin.
    expect(rpc.rpc).toHaveBeenCalledWith('admin_customer', {
      p_user_id: ids.user,
      p_test_mode: true,
    })
  })

  it('throws on any other error, or an answer it cannot read', async () => {
    const admin = await principal()
    session({ admin_customer: { error: { message: 'fetch failed' } } })
    await expect(getCustomer(admin, 'live', ids.user)).rejects.toBeInstanceOf(CustomersReadError)
    session({ admin_customer: { data: { userId: 'x' } } })
    await expect(getCustomer(admin, 'live', ids.user)).rejects.toBeInstanceOf(CustomersReadError)
  })
})

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id: ids.order,
  order_number: 'ND-001035',
  test_mode: true,
  status: 'completed',
  total_kobo: 2_010_250,
  created_at: '2026-10-02T09:00:00Z',
  paid_at: '2026-10-02T09:01:00Z',
  invoice_number: 'TEST-INV-000001',
  ...overrides,
})

describe('listCustomerOrders', () => {
  it('reads a page of this customer’s orders on the side, through the masked view', async () => {
    const admin = await principal({ testOnly: true, role: 'operator' })
    const reads = fakeService((read) => {
      if (read.table === 'admin_orders_v') return { data: [orderRow()], count: 26 }
      if (read.table === 'order_items') {
        return {
          data: [
            { order_id: ids.order, item_type: 'register' },
            { order_id: ids.order, item_type: 'ssl' },
          ],
        }
      }
      return undefined
    })
    const orders = await listCustomerOrders(admin, 'live', { userId: ids.user }, 2)
    const [view] = byTable(reads, 'admin_orders_v')
    expect(view?.select).toBe(
      'id, order_number, test_mode, status, total_kobo, created_at, paid_at, invoice_number',
    )
    expect(filterOf(view, 'eq', 'user_id')).toBe(ids.user)
    // adminDb's side filter: a test admin is on the Test side whatever was asked.
    expect(filterOf(view, 'eq', 'test_mode')).toBe(true)
    expect(view?.filters).toContainEqual(['range', 25, 49])
    const [lines] = byTable(reads, 'order_items')
    expect(filterOf(lines, 'in', 'order_id')).toEqual([ids.order])
    expect(lines?.select).toContain('admin_side:orders!inner(test_mode)')
    expect(orders).toEqual({
      total: 26,
      rows: [
        {
          id: ids.order,
          orderNumber: 'ND-001035',
          testMode: true,
          status: 'completed',
          totalKobo: 2_010_250,
          createdAt: '2026-10-02T09:00:00Z',
          paidAt: '2026-10-02T09:01:00Z',
          invoiceNumber: 'TEST-INV-000001',
          kinds: ['register', 'ssl'],
        },
      ],
    })
  })

  it('counts instead when the page is past the last one', async () => {
    const admin = await principal()
    let asked = 0
    const reads = fakeService((read) => {
      if (read.table !== 'admin_orders_v') return undefined
      asked += 1
      return asked === 1
        ? { error: { message: 'Requested range not satisfiable', code: 'PGRST103' } }
        : { data: [], count: 3 }
    })
    expect(await listCustomerOrders(admin, 'live', { userId: ids.user }, 9)).toEqual({
      rows: [],
      total: 3,
    })
    const count = byTable(reads, 'admin_orders_v')[1]
    expect(count?.options).toEqual({ count: 'exact', head: true })
    expect(filterOf(count, 'eq', 'user_id')).toBe(ids.user)
    expect(filterOf(count, 'eq', 'test_mode')).toBe(false)
  })

  it('reads no lines for no orders, and throws on a failed read', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({ data: [], count: 0 }))
    expect(await listCustomerOrders(admin, 'live', { userId: ids.user }, 1)).toEqual({
      rows: [],
      total: 0,
    })
    expect(byTable(reads, 'order_items')).toEqual([])
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    await expect(listCustomerOrders(admin, 'live', { userId: ids.user }, 1)).rejects.toBeInstanceOf(
      CustomersReadError,
    )
  })
})

describe('listCustomerLines', () => {
  it('reads the lines of the newest orders, with each order’s number', async () => {
    const admin = await principal()
    const reads = fakeService((read) => {
      if (read.table === 'admin_orders_v') {
        return {
          data: [
            { id: ids.order, order_number: 'ND-001035' },
            { id: ids.order2, order_number: 'ND-001036' },
          ],
          count: 2,
        }
      }
      if (read.table === 'order_items') {
        return {
          data: [
            {
              id: ids.line,
              order_id: ids.order2,
              domain: 'getpaid.com',
              domain_id: ids.domain,
              item_type: 'register',
              status: 'completed',
              ssl_product_code: null,
              created_at: '2026-10-02T09:00:00Z',
            },
          ],
        }
      }
      return undefined
    })
    const lines = await listCustomerLines(admin, 'live', { userId: ids.user })
    const [orders] = byTable(reads, 'admin_orders_v')
    expect(orders?.select).toBe('id, order_number')
    expect(filterOf(orders, 'eq', 'user_id')).toBe(ids.user)
    expect(filterOf(orders, 'eq', 'test_mode')).toBe(false)
    expect(orders?.filters).toContainEqual(['limit', LINE_ORDERS_CAP])
    const [items] = byTable(reads, 'order_items')
    expect(items?.select).toBe(
      'id, order_id, domain, domain_id, item_type, status, ssl_product_code, created_at, admin_side:orders!inner(test_mode)',
    )
    expect(filterOf(items, 'in', 'order_id')).toEqual([ids.order, ids.order2])
    expect(lines).toEqual({
      capped: false,
      lines: [
        {
          id: ids.line,
          orderId: ids.order2,
          orderNumber: 'ND-001036',
          domain: 'getpaid.com',
          domainId: ids.domain,
          itemType: 'register',
          status: 'completed',
          sslProductCode: null,
          createdAt: '2026-10-02T09:00:00Z',
        },
      ],
    })
  })

  it('says when there are more orders than one read takes', async () => {
    const admin = await principal()
    fakeService((read) =>
      read.table === 'admin_orders_v'
        ? { data: [{ id: ids.order, order_number: 'ND-1' }], count: LINE_ORDERS_CAP + 1 }
        : { data: [] },
    )
    expect((await listCustomerLines(admin, 'live', { userId: ids.user })).capped).toBe(true)
  })

  it('reads no lines for a customer with no orders', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({ data: [], count: 0 }))
    expect(await listCustomerLines(admin, 'live', { userId: ids.user })).toEqual({
      lines: [],
      capped: false,
    })
    expect(byTable(reads, 'order_items')).toEqual([])
  })
})

describe('sslProductNames', () => {
  it('names each product once, from the storefront’s list', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({
      data: [
        { product_code: '351', name: 'PositiveSSL' },
        { product_code: '352', name: null },
      ],
    }))
    const names = await sslProductNames(admin, 'live', ['351', '352', '351'])
    expect(filterOf(reads[0], 'in', 'product_code')).toEqual(['351', '352'])
    expect([...names]).toEqual([['351', 'PositiveSSL']])
  })

  it('reads nothing for no codes', async () => {
    const admin = await principal()
    expect((await sslProductNames(admin, 'live', [])).size).toBe(0)
    expect(createServiceClient).not.toHaveBeenCalled()
  })
})
