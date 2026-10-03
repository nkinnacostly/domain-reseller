import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminRefusal } from '@/features/admin/lib/errors'
import {
  ADMIN_TABLES,
  type AdminPrincipal,
  adminDb,
  adminSessionStatus,
  adminWhoami,
  findAdmin,
  getAdminSide,
  isAdminPrincipal,
  requireAdmin,
} from '@/features/admin/queries/session'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from './fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// requireAdmin is React's cache(): outside a render it would remember one answer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

type Call = [method: string, ...args: unknown[]]

/** A service client that records the query each read builds. */
function recordingService() {
  const calls: Call[] = []
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'range', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  const service = {
    from: (name: string) => {
      calls.push(['from', name])
      return builder
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(service as never)
  return calls
}

async function principal(overrides: Record<string, unknown> = {}): Promise<AdminPrincipal> {
  const session = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(session.client as never, null)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('adminDb', () => {
  it('refuses an object it did not issue, however it is shaped', async () => {
    const forged = { ...whoami() } as unknown as AdminPrincipal
    expect(isAdminPrincipal(forged)).toBe(false)
    expect(() => adminDb(forged, 'live')).toThrow(AdminRefusal)
  })

  it('has a select and nothing else: no insert, update, delete, upsert or rpc', async () => {
    recordingService()
    const db = adminDb(await principal(), 'live')
    const table = db.from('orders') as unknown as Record<string, unknown>
    expect(Object.keys(table)).toEqual(['select'])
    expect('rpc' in db).toBe(false)
  })

  it('reads only tables in its map', async () => {
    recordingService()
    const db = adminDb(await principal(), 'live')
    expect(() => db.from('profiles' as never)).toThrow('not an admin table')
    expect(() => db.from('toString' as never)).toThrow('not an admin table')
  })

  it.each([
    ['orders', 'live', [['eq', 'test_mode', false]]],
    ['orders', 'test', [['eq', 'test_mode', true]]],
    ['supplier_calls', 'live', [['eq', 'environment', 'production']]],
    ['supplier_calls', 'test', [['eq', 'environment', 'ote']]],
    ['order_items', 'test', [['eq', 'admin_side.test_mode', true]]],
    ['refund_events', 'live', [['eq', 'admin_side.test_mode', false]]],
    ['domain_events', 'test', [['eq', 'admin_side.test_mode', true]]],
    ['domain_nameserver_history', 'live', [['eq', 'admin_side.test_mode', false]]],
    ['order_item_costs', 'test', [['eq', 'admin_side.orders.test_mode', true]]],
    ['float_topups', 'live', []],
    ['float_topups', 'test', [['in', 'id', []]]],
    ['admin_audit_log', 'test', []],
    ['tlds', 'test', []],
    ['ops_settings', 'live', []],
  ] as const)('applies the side to %s on the %s side', async (table, side, filters) => {
    const calls = recordingService()
    await adminDb(await principal(), side)
      .from(table)
      .select('id')
    expect(calls.slice(2)).toEqual(filters)
  })

  it('embeds the parent under its own name, so a page can still embed the parent itself', async () => {
    const calls = recordingService()
    adminDb(await principal(), 'live')
      .from('order_items')
      .select('id, orders(order_number)')
    expect(calls[1]).toEqual([
      'select',
      'id, orders(order_number), admin_side:orders!inner(test_mode)',
      undefined,
    ])
  })

  it('passes count options through', async () => {
    const calls = recordingService()
    adminDb(await principal(), 'live')
      .from('jobs')
      .select('id', { count: 'exact', head: true })
    expect(calls[1]).toEqual(['select', 'id', { count: 'exact', head: true }])
  })

  describe('for a test administrator', () => {
    it('forces the test side whatever the page asks', async () => {
      const calls = recordingService()
      adminDb(await principal({ testOnly: true }), 'live')
        .from('refunds')
        .select('id')
      expect(calls).toContainEqual(['eq', 'test_mode', true])
    })

    it("shows only test administrators' own kind of audit rows", async () => {
      const calls = recordingService()
      adminDb(await principal({ testOnly: true }), 'test')
        .from('admin_audit_log')
        .select('id')
      expect(calls).toContainEqual(['eq', 'test_actor', true])
    })

    it.each(['ops_settings', 'service_heartbeats', 'nameserver_preset_drafts'] as const)(
      'refuses %s, which has no side and is not public',
      async (table) => {
        recordingService()
        const db = adminDb(await principal({ testOnly: true }), 'test')
        expect(() => db.from(table)).toThrow("Test administrators can't do this on live records.")
      },
    )

    it.each([
      'tlds',
      'ssl_products',
      'nameserver_presets',
      'fx_rates',
      'pricing_settings',
    ] as const)('reads %s, which the storefront already shows', async (table) => {
      recordingService()
      const db = adminDb(await principal({ testOnly: true }), 'test')
      expect(() => db.from(table).select('id')).not.toThrow()
    })
  })

  it('maps exactly the tables and views §2.3 allows, and none of the banned ones', () => {
    const names = Object.keys(ADMIN_TABLES)
    for (const banned of [
      'profiles',
      'payments',
      'email_outbox',
      'compliance_notices',
      'ssl_certificates',
      'domains',
      'transfer_secrets',
      'admins',
      'admin_changes',
    ]) {
      expect(names).not.toContain(banned)
    }
    const publicSafe = Object.entries(ADMIN_TABLES)
      .filter(([, entry]) => entry.side.kind === 'global' && entry.side.publicSafe)
      .map(([name]) => name)
    expect(publicSafe.sort()).toEqual(
      ['fx_rates', 'nameserver_presets', 'pricing_settings', 'ssl_products', 'tlds'].sort(),
    )
  })
})

describe('every mapped table', () => {
  it('reads from the table of its own name, with a side applied or marked global', async () => {
    const admin = await principal()
    for (const [name, entry] of Object.entries(ADMIN_TABLES)) {
      const calls = recordingService()
      adminDb(admin, 'test')
        .from(name as keyof typeof ADMIN_TABLES)
        .select('id')
      expect(calls[0], name).toEqual(['from', name])
      if (entry.side.kind === 'global' || entry.side.kind === 'test_actor') continue
      expect(calls.length, `${name} has a side filter`).toBeGreaterThan(2)
    }
  })

  it('makes one service client per reader', async () => {
    recordingService()
    const db = adminDb(await principal(), 'live')
    db.from('orders').select('id')
    db.from('jobs').select('id')
    expect(createServiceClient).toHaveBeenCalledTimes(1)
  })
})

describe('findAdmin', () => {
  it('is the admin, or null — never a 404 — for the sidebar', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_whoami: { data: whoami() } } }).client as never,
    )
    expect((await findAdmin())?.label).toBe('owner')
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_whoami: { error: { message: 'admin:weak_sign_in' } } } })
        .client as never,
    )
    expect(await findAdmin()).toBeNull()
    vi.mocked(createClient).mockResolvedValue(sessionClient({ user: null }).client as never)
    expect(await findAdmin()).toBeNull()
    expect(notFound).not.toHaveBeenCalled()
  })
})

describe('adminWhoami', () => {
  it('issues a frozen principal from the answer', async () => {
    const admin = await principal({ label: 'ops', role: 'operator' })
    expect(admin.label).toBe('ops')
    expect(Object.isFrozen(admin)).toBe(true)
    expect(isAdminPrincipal(admin)).toBe(true)
  })

  it('asks for a fresh code by minutes when told to', async () => {
    const session = sessionClient({ rpc: { admin_whoami: { data: whoami() } } })
    await adminWhoami(session.client as never, 5)
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
  })
})

describe('requireAdmin', () => {
  it('is a 404 for a visitor who is not signed in', async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ user: null }).client as never)
    await expect(requireAdmin()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is a 404 for a signed-in person who is not an admin', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_whoami: { error: { message: 'admin:not_admin' } } } })
        .client as never,
    )
    await expect(requireAdmin()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('sends an admin whose code is stale to enter one', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_whoami: { error: { message: 'admin:needs_code' } } } })
        .client as never,
    )
    await expect(requireAdmin()).rejects.toThrow('NEXT_REDIRECT /verify?next=/admin')
    expect(redirect).toHaveBeenCalledWith('/verify?next=/admin')
  })

  it('returns the admin', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_whoami: { data: whoami() } } }).client as never,
    )
    expect((await requireAdmin()).role).toBe('owner')
  })
})

describe('adminSessionStatus', () => {
  it.each(['ok', 'needs_code', 'factor_mismatch', 'weak_sign_in', 'not_admin'])(
    'passes on %s',
    async (status) => {
      vi.mocked(createClient).mockResolvedValue(
        sessionClient({ rpc: { admin_status: { data: status } } }).client as never,
      )
      expect(await adminSessionStatus()).toBe(status)
    },
  )

  it('is not_admin when signed out, on an error, or on a word it does not know', async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ user: null }).client as never)
    expect(await adminSessionStatus()).toBe('not_admin')
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_status: { error: { message: 'boom' } } } }).client as never,
    )
    expect(await adminSessionStatus()).toBe('not_admin')
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_status: { data: 'superuser' } } }).client as never,
    )
    expect(await adminSessionStatus()).toBe('not_admin')
  })
})

describe('getAdminSide', () => {
  function cookie(value: string | undefined) {
    vi.mocked(cookies).mockResolvedValue({
      get: () => (value === undefined ? undefined : { value }),
    } as never)
  }

  it('reads the cookie, live by default', async () => {
    const admin = await principal()
    cookie('test')
    expect(await getAdminSide(admin)).toBe('test')
    cookie(undefined)
    expect(await getAdminSide(admin)).toBe('live')
    cookie('production')
    expect(await getAdminSide(admin)).toBe('live')
  })

  it('keeps a test administrator on the test side', async () => {
    cookie('live')
    expect(await getAdminSide(await principal({ testOnly: true }))).toBe('test')
  })
})
