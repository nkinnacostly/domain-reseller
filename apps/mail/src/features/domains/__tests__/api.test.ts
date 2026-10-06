import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET as getOne } from '@/app/api/v1/domains/[id]/route'
import { POST as verify } from '@/app/api/v1/domains/[id]/verify/route'
import { POST as create, GET as list } from '@/app/api/v1/domains/route'
import { useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * /api/v1/domains (MAIL-SPEC §5, §6): a full-access key only (asked again in
 * SQL), JSON in the API's shape with `x-request-id`, the records to add, and
 * the SES work done at once — against a fake SES and the SQL functions'
 * recorded answers.
 */

vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test only, not a key: signs nothing'
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events'
})

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  connection: async () => undefined,
}))

const KEY = `mdh_live_${'Zz9Yy8Xx'.repeat(5)}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const TOKENS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
]

const key = (permission: 'full' | 'sending') => ({
  ok: true,
  keyId: KEY_ID,
  accountId: ACCOUNT,
  permission,
  domainId: null,
})

const VIEW = {
  id: DOMAIN,
  name: 'acme.example',
  status: 'pending',
  dkimTokens: TOKENS,
  dkimStatus: 'PENDING',
  mailFromDomain: 'send.acme.example',
  mailFromStatus: null,
  failedReason: null,
  missingRecord: null,
  settingUp: false,
  createdAt: '2026-10-06T09:30:00.000000Z',
  claimedAt: '2026-10-06T09:30:00.000000Z',
  deadline: '2026-10-09T09:30:00.000000Z',
  verifiedAt: null,
  lastCheckedAt: null,
}

const request = (url: string, method = 'GET', body?: unknown, auth: string | null = KEY) =>
  new Request(`http://localhost:3001/api/v1/domains${url}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  const ses = useFakeSes()
  useFakeDoh(ses)
})

describe('keys', () => {
  it('no key: 401 in the API’s shape, with a request id', async () => {
    const calls = mockRpc({})
    const response = await list(request('', 'GET', undefined, null))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ name: 'unauthorized' })
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls).toHaveLength(0)
  })

  it('a sending key may not manage domains', async () => {
    const calls = mockRpc({ authenticate_key: () => key('sending') })
    const response = await create(request('', 'POST', { name: 'acme.example' }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: 'forbidden' })
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })

  it('SQL asks again: a key it refuses is forbidden', async () => {
    mockRpc({
      authenticate_key: () => key('full'),
      api_list_domains: () => ({ ok: false, code: 'forbidden' }),
    })
    expect((await list(request(''))).status).toBe(403)
  })
})

describe('GET /domains and GET /domains/{id}', () => {
  it('lists the account’s domains with the records to add', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_list_domains: () => ({
        ok: true,
        domains: [
          VIEW,
          {
            ...VIEW,
            id: KEY_ID,
            status: 'failed',
            failedReason: 'dkim_record_missing',
            missingRecord: 'x._domainkey.acme.example',
          },
        ],
      }),
    })
    const response = await list(request(''))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data[0]).toMatchObject({
      object: 'domain',
      id: DOMAIN,
      name: 'acme.example',
      status: 'pending',
      setting_up: false,
      verify_by: VIEW.deadline,
      failure: null,
    })
    expect(body.data[0].records).toHaveLength(6)
    expect(body.data[0].records[3]).toEqual({
      record: 'mail_from_mx',
      type: 'MX',
      name: 'send.acme.example',
      value: 'feedback-smtp.eu-west-2.amazonses.com',
      priority: 10,
      required: true,
    })
    expect(body.data[1]).toMatchObject({
      status: 'failed',
      failure: { reason: 'dkim_record_missing', missing_record: 'x._domainkey.acme.example' },
      records: [],
    })
    expect(calls.find((call) => call.fn === 'api_list_domains')?.body).toEqual({
      p_account_id: ACCOUNT,
      p_actor_key_id: KEY_ID,
    })
  })

  it('reads one; another account’s, or no such id, is not found', async () => {
    mockRpc({
      authenticate_key: () => key('full'),
      api_get_domain: (body) =>
        body.p_domain_id === DOMAIN ? { ok: true, domain: VIEW } : { ok: false, code: 'not_found' },
    })
    expect((await getOne(request(`/${DOMAIN}`), params(DOMAIN))).status).toBe(200)
    expect((await getOne(request(`/${KEY_ID}`), params(KEY_ID))).status).toBe(404)
    const odd = await getOne(request('/nope'), params('nope'))
    expect(odd.status).toBe(404)
    expect(await odd.json()).toMatchObject({ name: 'not_found' })
  })

  it('an answer we did not expect is our error, logged by route', async () => {
    mockRpc({ authenticate_key: () => key('full'), api_list_domains: () => ({ what: 'ever' }) })
    const response = await list(request(''))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ name: 'internal_error' })
  })
})

describe('POST /domains', () => {
  it('adds the domain, sets it up with SES at once, and answers its records', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_add_domain: () => ({ ok: true, domainId: DOMAIN, name: 'acme.example' }),
      claim_provisioning_work: () => [],
      claim_domain_work: () => [],
      api_get_domain: () => ({ ok: true, domain: VIEW }),
    })
    const response = await create(request('', 'POST', { name: 'https://Acme.Example/' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ object: 'domain', id: DOMAIN })
    expect(calls.find((call) => call.fn === 'api_add_domain')?.body).toEqual({
      p_account_id: ACCOUNT,
      p_actor_key_id: KEY_ID,
      p_name: 'acme.example',
    })
    expect(calls.find((call) => call.fn === 'claim_domain_work')?.body).toMatchObject({
      p_domain_id: DOMAIN,
      p_account_id: ACCOUNT,
    })
  })

  it('a body that is not JSON, or not a domain, is a validation error', async () => {
    mockRpc({ authenticate_key: () => key('full') })
    const notJson = await create(request('', 'POST', 'name=acme'))
    expect(notJson.status).toBe(422)
    expect(await notJson.json()).toMatchObject({ name: 'validation_error' })
    expect((await create(request('', 'POST', { name: 'not a domain' }))).status).toBe(422)
    expect((await create(request('', 'POST', {}))).status).toBe(422)
  })

  it('SQL’s refusals: in use is a conflict, our names a validation error', async () => {
    mockRpc({
      authenticate_key: () => key('full'),
      api_add_domain: (body) =>
        body.p_name === 'acme.example'
          ? { ok: false, code: 'in_use' }
          : { ok: false, code: 'reserved' },
    })
    const inUse = await create(request('', 'POST', { name: 'acme.example' }))
    expect(inUse.status).toBe(409)
    expect((await inUse.json()).message).toContain('in use on another account')
    expect((await create(request('', 'POST', { name: 'x.mydomainshub.com' }))).status).toBe(422)
  })

  it('the domain not readable after adding: our error', async () => {
    mockRpc({
      authenticate_key: () => key('full'),
      api_add_domain: () => ({ ok: true, domainId: DOMAIN, name: 'acme.example' }),
      claim_provisioning_work: () => [],
      claim_domain_work: () => [],
      api_get_domain: () => ({ ok: false, code: 'not_found' }),
    })
    expect((await create(request('', 'POST', { name: 'acme.example' }))).status).toBe(404)
  })
})

describe('POST /domains/{id}/verify and DELETE /domains/{id}', () => {
  it('verify reads SES now, then answers the domain', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_get_domain: () => ({ ok: true, domain: VIEW }),
      claim_provisioning_work: () => [],
      claim_domain_work: () => [],
    })
    const response = await verify(request(`/${DOMAIN}/verify`, 'POST'), params(DOMAIN))
    expect(response.status).toBe(200)
    expect(calls.filter((call) => call.fn === 'api_get_domain')).toHaveLength(2)
    expect(calls.some((call) => call.fn === 'claim_domain_work')).toBe(true)
  })

  it('verify on a failed domain reads nothing from SES; a bad id or another’s is not found', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_get_domain: (body) =>
        body.p_domain_id === DOMAIN
          ? { ok: true, domain: { ...VIEW, status: 'failed' } }
          : { ok: false, code: 'not_found' },
    })
    expect((await verify(request(`/${DOMAIN}/verify`, 'POST'), params(DOMAIN))).status).toBe(200)
    expect(calls.some((call) => call.fn === 'claim_domain_work')).toBe(false)
    expect((await verify(request('/x/verify', 'POST'), params('x'))).status).toBe(404)
    expect((await verify(request(`/${KEY_ID}/verify`, 'POST'), params(KEY_ID))).status).toBe(404)
  })

  it('verify when the domain went between the two reads', async () => {
    let reads = 0
    mockRpc({
      authenticate_key: () => key('full'),
      api_get_domain: () =>
        reads++ === 0 ? { ok: true, domain: VIEW } : { ok: false, code: 'not_found' },
      claim_provisioning_work: () => [],
      claim_domain_work: () => [],
    })
    expect((await verify(request(`/${DOMAIN}/verify`, 'POST'), params(DOMAIN))).status).toBe(404)
  })

  it('delete removes, lets the identity go, and answers deleted', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_remove_domain: () => ({ ok: true, domainId: DOMAIN, needsRelease: true }),
      claim_domain_work: () => [],
    })
    const response = await DELETE(request(`/${DOMAIN}`, 'DELETE'), params(DOMAIN))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: 'domain', id: DOMAIN, deleted: true })
    expect(calls.some((call) => call.fn === 'claim_domain_work')).toBe(true)
  })

  it('delete refused while emails wait is a conflict; a bad id not found', async () => {
    mockRpc({
      authenticate_key: () => key('full'),
      api_remove_domain: () => ({ ok: false, code: 'emails_queued', count: 1 }),
    })
    const response = await DELETE(request(`/${DOMAIN}`, 'DELETE'), params(DOMAIN))
    expect(response.status).toBe(409)
    expect((await response.json()).message).toContain('One email is still waiting')
    expect((await DELETE(request('/x', 'DELETE'), params('x'))).status).toBe(404)
  })

  it('delete of a claim already let go asks SES nothing', async () => {
    const calls = mockRpc({
      authenticate_key: () => key('full'),
      api_remove_domain: () => ({ ok: true, domainId: DOMAIN, needsRelease: false }),
    })
    expect((await DELETE(request(`/${DOMAIN}`, 'DELETE'), params(DOMAIN))).status).toBe(200)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key', 'api_remove_domain'])
  })

  it('sending keys are refused on every path', async () => {
    mockRpc({ authenticate_key: () => key('sending') })
    expect((await getOne(request(`/${DOMAIN}`), params(DOMAIN))).status).toBe(403)
    expect((await verify(request(`/${DOMAIN}/verify`, 'POST'), params(DOMAIN))).status).toBe(403)
    expect((await DELETE(request(`/${DOMAIN}`, 'DELETE'), params(DOMAIN))).status).toBe(403)
  })
})
