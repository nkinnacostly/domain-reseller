import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCustomerListParams } from '@/features/admin/lib/customers-params'
import {
  CustomersReadError,
  getCustomer,
  getCustomerStats,
  listCustomerCertificates,
  listCustomerDomains,
  listCustomerEmails,
  listCustomerOrders,
  listCustomers,
  TAB_EMAILS_SHOWN,
  TAB_ROWS_CAP,
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

describe('a customer’s domains, certificates and emails, from the masked views', () => {
  it('reads the domains by user id on the side, newest first, without demo rows', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({
      data: [
        {
          id: ids.domain,
          domain_name: 'getpaid.com',
          local_status: 'active',
          expires_at: '2027-10-02T09:00:00Z',
          auto_renew: true,
          registered_at: '2026-10-02T09:00:00Z',
          created_at: '2026-10-02T08:00:00Z',
          test_mode: false,
        },
      ],
      count: 1,
    }))
    const domains = await listCustomerDomains(admin, 'live', { userId: ids.user })
    const [read] = reads
    expect(read?.table).toBe('admin_domains_v')
    expect(read?.select).toBe(
      'id, domain_name, local_status, expires_at, auto_renew, registered_at, created_at, test_mode',
    )
    expect(read?.select).not.toMatch(/registrant/)
    expect(filterOf(read, 'eq', 'user_id')).toBe(ids.user)
    expect(filterOf(read, 'eq', 'test_mode')).toBe(false)
    expect(filterOf(read, 'neq', 'source')).toBe('demo')
    expect(read?.filters).toContainEqual(['limit', TAB_ROWS_CAP])
    expect(domains).toEqual({
      total: 1,
      rows: [
        {
          id: ids.domain,
          domainName: 'getpaid.com',
          status: 'active',
          expiresAt: '2027-10-02T09:00:00Z',
          autoRenew: true,
          registeredAt: '2026-10-02T09:00:00Z',
          createdAt: '2026-10-02T08:00:00Z',
          testMode: false,
        },
      ],
    })
  })

  it('reads the certificates by user id, names and dates only — never the approver or the certificate', async () => {
    const admin = await principal({ testOnly: true, role: 'operator' })
    const reads = fakeService(() => ({
      data: [
        {
          id: ids.line,
          common_name: 'shop.ng',
          product_name: 'PositiveSSL',
          status: 'issued',
          issued_at: '2026-10-02T09:00:00Z',
          expires_at: '2027-04-20T09:00:00Z',
          created_at: '2026-10-01T09:00:00Z',
          test_mode: true,
        },
      ],
      count: 140,
    }))
    const certificates = await listCustomerCertificates(admin, 'live', { userId: ids.user })
    const [read] = reads
    expect(read?.table).toBe('admin_ssl_certificates_v')
    expect(read?.select).not.toMatch(/approver|_pem/)
    // A test admin is held to the Test side whatever is asked.
    expect(filterOf(read, 'eq', 'test_mode')).toBe(true)
    expect(filterOf(read, 'eq', 'user_id')).toBe(ids.user)
    expect(certificates.total).toBe(140)
    expect(certificates.rows[0]).toMatchObject({ name: 'shop.ng', product: 'PositiveSSL' })
  })

  it('reads the newest emails by user id: what and when, never the recipient or the error', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({
      data: [
        {
          id: ids.key,
          kind: 'order_receipt',
          category: 'transactional',
          status: 'sent',
          delivery_status: 'delivered',
          created_at: '2026-10-02T09:00:00Z',
          sent_at: '2026-10-02T09:01:00Z',
          test_mode: false,
        },
      ],
      count: 31,
    }))
    const emails = await listCustomerEmails(admin, 'live', { userId: ids.user })
    const [read] = reads
    expect(read?.table).toBe('admin_email_outbox_v')
    expect(read?.select).not.toMatch(/masked_to|last_error/)
    expect(read?.filters).toContainEqual(['limit', TAB_EMAILS_SHOWN])
    expect(emails).toMatchObject({ total: 31, rows: [{ kind: 'order_receipt', status: 'sent' }] })
  })

  it('throws a read error the tab shows in words', async () => {
    const admin = await principal()
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    for (const list of [listCustomerDomains, listCustomerCertificates, listCustomerEmails]) {
      await expect(list(admin, 'live', { userId: ids.user })).rejects.toBeInstanceOf(
        CustomersReadError,
      )
    }
    expect(createServiceClient).toHaveBeenCalled()
  })
})
