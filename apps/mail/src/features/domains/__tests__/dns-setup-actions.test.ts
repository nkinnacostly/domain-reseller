import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { type FakeCloudflare, useFakeCloudflare } from '../../../../tests/mocks/cloudflare'
import { type FakeSes, useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { ACCOUNT, fakeSupabase } from '../../accounts/__tests__/fake-supabase'

/**
 * "Add to Cloudflare" (MAIL-SPEC §5.3; migration 57): the role check first,
 * then SQL as the person, then Cloudflare — the records made from what SQL
 * answered, the token used once and never sent anywhere else, and each
 * outcome in words.
 */

vi.hoisted(() => {
  const crypto = process.getBuiltinModule('node:crypto')
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  process.env.MAIL_DOMAIN_CONNECT_PRIVATE_KEY = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64')
  process.env.NEXT_PUBLIC_MAIL_URL = 'https://emails.mydomainshub.com'
})

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: vi.fn() }))

const { addRecordsWithCloudflareToken, startCloudflareConnect } = await import(
  '../actions/dns-setup'
)

const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const TOKEN = 'cf-test-token-not-a-secret-0123456789abcd'
const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]

const started = (name = 'acme.example') => ({
  data: { ok: true, domainId: DOMAIN, name, mailFromDomain: `send.${name}`, dkimTokens: TOKENS },
  error: null,
})

function use(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

let ses: FakeSes
let cf: FakeCloudflare

beforeEach(() => {
  vi.clearAllMocks()
  ses = useFakeSes()
  useFakeDoh(ses)
  cf = useFakeCloudflare(ses)
})

describe('addRecordsWithCloudflareToken', () => {
  it('a viewer is refused before anything reaches SQL or Cloudflare', async () => {
    const fake = use({ role: 'viewer' })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    expect(result.serverError).toContain('cannot do that')
    expect(fake.rpcCalls).toHaveLength(0)
    expect(cf.calls).toHaveLength(0)
  })

  it('something that is not a token is refused here, without repeating it', async () => {
    const fake = use({ role: 'developer' })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: 'my global key 0f1e2d3c',
    })
    const words = JSON.stringify(result.validationErrors)
    expect(words).toContain('does not look like a Cloudflare API token')
    expect(words).not.toContain('0f1e2d3c')
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('SQL’s refusal is said in words, and Cloudflare is not asked', async () => {
    use({
      rpc: { start_dns_setup: () => ({ data: { ok: false, code: 'too_many' }, error: null }) },
    })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    expect(result.data).toEqual({ error: expect.stringContaining('ten tries for this domain') })
    expect(cf.calls).toHaveLength(0)
  })

  it('adds the records SQL describes, and never sends the token to SQL', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    const fake = use({ rpc: { start_dns_setup: () => started() } })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: ` ${TOKEN} `,
    })
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'start_dns_setup',
        args: { p_domain_id: DOMAIN, p_provider: 'cloudflare', p_method: 'token' },
      },
    ])
    expect(result.data).toMatchObject({ ok: true, zone: 'acme.example', stopped: null })
    const data = result.data as { results: { outcome: string }[] }
    expect(data.results.map((r) => r.outcome)).toEqual(Array(6).fill('added'))
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/domains/${DOMAIN}`)
  })

  it('a token that cannot reach the zone names the zone from public DNS', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, [])
    use({ rpc: { start_dns_setup: () => started('mail.acme.example') } })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    expect(result.data).toEqual({
      error: expect.stringContaining(
        'cannot reach acme.example. When you create it, pick acme.example',
      ),
    })
  })

  it('an unknown token is refused, with nothing changed', async () => {
    cf.addZone('acme.example')
    use({ rpc: { start_dns_setup: () => started() } })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    expect(result.data).toEqual({ error: expect.stringContaining('did not accept that token') })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('a run that stopped part-way says so', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    cf.failAfter(3)
    use({ rpc: { start_dns_setup: () => started() } })
    const result = await addRecordsWithCloudflareToken({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    expect(result.data).toMatchObject({
      ok: true,
      stopped: expect.stringContaining('stopped answering part-way'),
    })
  })
})

describe('startCloudflareConnect', () => {
  it('answers Cloudflare’s signed apply address for the zone public DNS names', async () => {
    cf.addZone('acme.example')
    const fake = use({ rpc: { start_dns_setup: () => started('mail.acme.example') } })
    const result = await startCloudflareConnect({ accountId: ACCOUNT, domainId: DOMAIN })
    const data = result.data as { url: string }
    const url = new URL(data.url)
    expect(url.origin).toBe('https://dash.cloudflare.com')
    expect(url.searchParams.get('domain')).toBe('acme.example')
    expect(url.searchParams.get('host')).toBe('mail')
    expect(url.searchParams.get('redirect_uri')).toBe(
      `https://emails.mydomainshub.com/dashboard/domains/${DOMAIN}?from=cloudflare`,
    )
    expect(data.url).toMatch(/&key=_dck1&sig=[^&]+$/)
    expect(fake.rpcCalls[0]?.args).toEqual({
      p_domain_id: DOMAIN,
      p_provider: 'cloudflare',
      p_method: 'domain_connect',
    })
  })

  it('a domain whose DNS is not on Cloudflare is told so', async () => {
    ses.publish('acme.example', 'NS', 'ns1.other.example.')
    use({ rpc: { start_dns_setup: () => started() } })
    const result = await startCloudflareConnect({ accountId: ACCOUNT, domainId: DOMAIN })
    expect(result.data).toEqual({
      error: expect.stringContaining('could not confirm this domain’s DNS is on Cloudflare'),
    })
  })

  it('a MAIL FROM the template does not cover is not sent', async () => {
    cf.addZone('acme.example')
    use({
      rpc: {
        start_dns_setup: () => ({
          data: { ...started().data, mailFromDomain: 'bounce.acme.example' },
          error: null,
        }),
      },
    })
    const result = await startCloudflareConnect({ accountId: ACCOUNT, domainId: DOMAIN })
    expect(result.data).toEqual({ error: expect.stringContaining('Nothing was changed') })
  })

  it('a viewer is refused', async () => {
    const fake = use({ role: 'viewer' })
    const result = await startCloudflareConnect({ accountId: ACCOUNT, domainId: DOMAIN })
    expect(result.serverError).toContain('cannot do that')
    expect(fake.rpcCalls).toHaveLength(0)
  })
})
