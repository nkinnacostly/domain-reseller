import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { ACCOUNT, fakeSupabase } from '../../accounts/__tests__/fake-supabase'
import { domainItem, fakeJobsSql } from '../../tenants/__tests__/fake-sql'

/**
 * The domains page's actions (MAIL-SPEC §5; migration 47): the role check
 * first, then SQL as the person, then the SES work at once — and what each
 * answers in words.
 */

vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test only, not a key: signs nothing'
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events'
})

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: vi.fn() }))

const { addDomain, checkDomain, removeDomain, retryDomain } = await import('../actions/domains')

const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'

function use(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
  const ses = useFakeSes()
  useFakeDoh(ses)
  ses.handle('POST', '/v2/email/tenants', { TenantName: 'mdm-0a1b2c3d4e' })
  ses.handle('POST', '/v2/email/configuration-sets', { ConfigurationSetName: 'mdm-0a1b2c3d4e' })
})

describe('addDomain (§5)', () => {
  it('a viewer is refused before anything reaches SQL', async () => {
    const fake = use({ role: 'viewer' })
    const result = await addDomain({ accountId: ACCOUNT, name: 'acme.example' })
    expect(result.serverError).toContain('cannot do that')
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('a name that cannot be a domain is refused here, in words', async () => {
    const fake = use({ role: 'developer' })
    expect((await addDomain({ accountId: ACCOUNT, name: 'not a domain' })).data).toEqual({
      error: expect.stringContaining('not a domain we can verify'),
      code: 'validation',
    })
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('claims the name as the person, then sets it up with SES at once', async () => {
    const fake = use({
      role: 'developer',
      rpc: {
        add_domain: () => ({
          data: { ok: true, domainId: DOMAIN, name: 'acme.example' },
          error: null,
        }),
      },
    })
    const sql = fakeJobsSql({ domains: [domainItem({ id: DOMAIN, accountId: ACCOUNT })] })
    const result = await addDomain({ accountId: ACCOUNT, name: ' Acme.Example. ' })
    expect(result.data).toEqual({ ok: true, domainId: DOMAIN })
    expect(fake.rpcCalls).toEqual([
      { fn: 'add_domain', args: { p_account_id: ACCOUNT, p_name: 'acme.example' } },
    ])
    const claims = sql.calls.filter((call) => call.fn === 'claim_domain_work')
    expect(claims[0]?.body).toMatchObject({
      p_domain_id: DOMAIN,
      p_account_id: ACCOUNT,
      p_e2e: false,
    })
    expect(sql.args('record_domain_step', 'p_step')).toEqual([
      'identity',
      'mail_from',
      'config_set',
      'tenant',
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/domains', 'layout')
  })

  it('a name already on the account opens it', async () => {
    use({
      rpc: {
        add_domain: () => ({
          data: { ok: false, code: 'already_added', domainId: DOMAIN },
          error: null,
        }),
      },
    })
    expect((await addDomain({ accountId: ACCOUNT, name: 'acme.example' })).data).toEqual({
      ok: true,
      domainId: DOMAIN,
    })
  })

  it('SQL’s refusal in words', async () => {
    use({ rpc: { add_domain: () => ({ data: { ok: false, code: 'in_use' }, error: null }) } })
    expect((await addDomain({ accountId: ACCOUNT, name: 'acme.example' })).data).toEqual({
      error: expect.stringContaining('in use on another account'),
      code: 'in_use',
    })
  })

  it('SQL failing is our error, not the person’s', async () => {
    use({ rpc: { add_domain: () => ({ data: null, error: { code: '08006' } }) } })
    expect((await addDomain({ accountId: ACCOUNT, name: 'acme.example' })).serverError).toContain(
      'Something went wrong',
    )
  })
})

describe('checkDomain ("Check now")', () => {
  it('any member may; the outcome comes back', async () => {
    use({ role: 'viewer' })
    fakeJobsSql({ domains: [domainItem({ id: DOMAIN, accountId: ACCOUNT, work: 'check' })] })
    expect((await checkDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({
      ok: true,
      outcome: 'pending',
    })
  })

  it('a domain a run is already working is left to it', async () => {
    use()
    fakeJobsSql()
    expect((await checkDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({
      ok: true,
      outcome: 'busy',
    })
  })
})

describe('removeDomain and retryDomain', () => {
  it('removing lets the identity go at once when SQL says there is one', async () => {
    const fake = use({
      rpc: {
        remove_domain: () => ({
          data: { ok: true, domainId: DOMAIN, needsRelease: true },
          error: null,
        }),
      },
    })
    const sql = fakeJobsSql({
      domains: [
        domainItem({ id: DOMAIN, accountId: ACCOUNT, work: 'teardown', status: 'removing' }),
      ],
    })
    expect((await removeDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({
      ok: true,
    })
    expect(fake.rpcCalls[0]).toEqual({ fn: 'remove_domain', args: { p_domain_id: DOMAIN } })
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(true)
  })

  it('a claim already let go needs nothing from SES', async () => {
    use({
      rpc: {
        remove_domain: () => ({
          data: { ok: true, domainId: DOMAIN, needsRelease: false },
          error: null,
        }),
      },
    })
    const sql = fakeJobsSql()
    expect((await removeDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({
      ok: true,
    })
    expect(sql.calls).toHaveLength(0)
  })

  it('refused while emails wait, in words', async () => {
    use({
      rpc: {
        remove_domain: () => ({
          data: { ok: false, code: 'emails_queued', count: 2 },
          error: null,
        }),
      },
    })
    expect((await removeDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({
      error: expect.stringContaining('2 emails are still waiting'),
      code: 'emails_queued',
    })
  })

  it('a viewer cannot remove or retry', async () => {
    const fake = use({ role: 'viewer' })
    expect((await removeDomain({ accountId: ACCOUNT, domainId: DOMAIN })).serverError).toContain(
      'cannot do that',
    )
    expect((await retryDomain({ accountId: ACCOUNT, domainId: DOMAIN })).serverError).toContain(
      'cannot do that',
    )
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('a retry starts the set-up again', async () => {
    use({ rpc: { retry_domain: () => ({ data: { ok: true, domainId: DOMAIN }, error: null }) } })
    const sql = fakeJobsSql({ domains: [domainItem({ id: DOMAIN, accountId: ACCOUNT })] })
    expect((await retryDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toEqual({ ok: true })
    expect(sql.args('record_domain_step', 'p_step')).toContain('identity')
  })

  it('a retry SQL refuses, and SQL failing', async () => {
    use({ rpc: { retry_domain: () => ({ data: { ok: false, code: 'releasing' }, error: null }) } })
    expect((await retryDomain({ accountId: ACCOUNT, domainId: DOMAIN })).data).toMatchObject({
      code: 'releasing',
    })
    use({ rpc: { retry_domain: () => ({ data: null, error: { code: '08006' } }) } })
    expect((await retryDomain({ accountId: ACCOUNT, domainId: DOMAIN })).serverError).toBeTruthy()
    use({ rpc: { remove_domain: () => ({ data: null, error: { code: '08006' } }) } })
    expect((await removeDomain({ accountId: ACCOUNT, domainId: DOMAIN })).serverError).toBeTruthy()
  })
})
