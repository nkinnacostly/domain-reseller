import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { domainRow, fakeReads } from './fake-reads'

/** The domains page's reads, as the person (RLS, migration 43 and 47). */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { getDomain, getSandboxSender, isTenantReady, listDomains } = await import(
  '../queries/domains'
)

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

function use(tables: Parameters<typeof fakeReads>[0]) {
  const fake = fakeReads(tables)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('listDomains', () => {
  it('the account’s domains not removed, newest first, the sandbox row apart', async () => {
    const fake = use({
      domains: {
        data: [
          domainRow(),
          domainRow({ id: 'a', name: 'xn--caf-dma.example', identity_created_at: null }),
          domainRow({
            id: 's',
            name: 'sandbox.emails.mydomainshub.com',
            kind: 'sandbox',
            status: 'sandbox',
          }),
        ],
        error: null,
      },
    })
    const { domains, sandbox } = await listDomains(ACCOUNT)
    expect(domains.map((d) => [d.name, d.unicode, d.settingUp])).toEqual([
      ['acme.example', null, false],
      ['xn--caf-dma.example', 'café.example', true],
    ])
    expect(domains[0]?.deadline).toBe('2026-10-09T09:30:00.000Z')
    expect(sandbox?.name).toBe('sandbox.emails.mydomainshub.com')
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { table: 'domains', method: 'eq', args: ['account_id', ACCOUNT] },
        { table: 'domains', method: 'neq', args: ['status', 'removed'] },
      ]),
    )
  })

  it('a read that fails throws, so the page shows its error state', async () => {
    use({ domains: { data: null, error: { code: '08006' } } })
    await expect(listDomains(ACCOUNT)).rejects.toThrow('08006')
  })

  it('a verified domain has no deadline; nothing at all is an empty list', async () => {
    use({
      domains: {
        data: [domainRow({ status: 'verified', verified_at: '2026-10-06T10:00:00+00:00' })],
        error: null,
      },
    })
    expect((await listDomains(ACCOUNT)).domains[0]?.deadline).toBeNull()
    use({ domains: { data: null, error: null } })
    expect(await listDomains(ACCOUNT)).toEqual({ domains: [], sandbox: null })
  })
})

describe('getDomain', () => {
  it('one customer domain of the account', async () => {
    const fake = use({ domains: { data: domainRow(), error: null } })
    expect((await getDomain(ACCOUNT, '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'))?.name).toBe(
      'acme.example',
    )
    expect(fake.calls).toEqual(
      expect.arrayContaining([{ table: 'domains', method: 'eq', args: ['kind', 'customer'] }]),
    )
  })

  it('not an id, not there, or unreadable', async () => {
    const fake = use({ domains: { data: null, error: null } })
    expect(await getDomain(ACCOUNT, 'nope')).toBeNull()
    expect(fake.calls).toHaveLength(0)
    expect(await getDomain(ACCOUNT, '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f')).toBeNull()
    use({ domains: { data: null, error: { code: '08006' } } })
    await expect(getDomain(ACCOUNT, '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f')).rejects.toThrow()
  })
})

describe('the sandbox sender and the tenant', () => {
  it('reads the shared sender’s address and state', async () => {
    use({
      sandbox_identity: {
        data: { from_address: 'onboarding@sandbox.emails.mydomainshub.com', status: 'verified' },
        error: null,
      },
    })
    expect(await getSandboxSender()).toEqual({
      fromAddress: 'onboarding@sandbox.emails.mydomainshub.com',
      status: 'verified',
    })
    use({ sandbox_identity: { data: { from_address: 'x', status: 'odd' }, error: null } })
    expect(await getSandboxSender()).toBeNull()
    use({ sandbox_identity: { data: null, error: { code: '42501' } } })
    expect(await getSandboxSender()).toBeNull()
  })

  it('whether the account’s tenant is ready, or unknown', async () => {
    use({ accounts: { data: { tenant_ready_at: '2026-10-06T09:30:00Z' }, error: null } })
    expect(await isTenantReady(ACCOUNT)).toBe(true)
    use({ accounts: { data: { tenant_ready_at: null }, error: null } })
    expect(await isTenantReady(ACCOUNT)).toBe(false)
    use({ accounts: { data: null, error: { code: '08006' } } })
    expect(await isTenantReady(ACCOUNT)).toBeNull()
  })
})
