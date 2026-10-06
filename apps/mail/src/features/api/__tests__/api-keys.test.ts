import { hashApiKey, isApiKey } from '@dr/shared/mail'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE } from '@/app/api/v1/api-keys/[id]/route'
import { GET, POST } from '@/app/api/v1/api-keys/route'
import { logger } from '@/lib/logger'
import { mockRpc } from '../../../../tests/mocks/supabase'

/** /api/v1/api-keys (§6, MR7): full-access keys only; a new key answered once, stored as a hash. */

const KEY = `mdh_live_${'K3ysK3ys'.repeat(5)}`
const PEPPER = 'test pepper, not a secret, 0123456789'
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const NEW_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const FULL = { ok: true, keyId: KEY_ID, accountId: ACCOUNT, permission: 'full', domainId: null }

const ROW = {
  id: NEW_ID,
  name: 'Billing',
  prefix: 'mdh_live_Ab12',
  permission: 'sending',
  domainId: DOMAIN,
  createdAt: '2026-10-06T09:30:00.000000Z',
  lastUsedAt: null,
}

const auth = { authorization: `Bearer ${KEY}` }
const create = (body: unknown) =>
  POST(
    new Request('http://localhost:3001/api/v1/api-keys', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
const revoke = (id: string) =>
  DELETE(
    new Request(`http://localhost:3001/api/v1/api-keys/${id}`, { method: 'DELETE', headers: auth }),
    {
      params: Promise.resolve({ id }),
    },
  )

let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  info = vi.spyOn(logger, 'info')
})
afterEach(() => vi.restoreAllMocks())

describe('GET /api/v1/api-keys', () => {
  it('lists the account’s live keys in the API’s words, never a hash', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      api_list_keys: () => ({ ok: true, keys: [ROW] }),
    })
    const response = await GET(
      new Request('http://localhost:3001/api/v1/api-keys', { headers: auth }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        {
          object: 'api_key',
          id: NEW_ID,
          name: 'Billing',
          prefix: 'mdh_live_Ab12',
          permission: 'sending',
          domain_id: DOMAIN,
          created_at: ROW.createdAt,
          last_used_at: null,
        },
      ],
    })
    expect(calls[1]).toMatchObject({ fn: 'api_list_keys', body: { p_account_id: ACCOUNT } })
  })

  it('takes a full-access key only', async () => {
    mockRpc({ authenticate_key: () => ({ ...FULL, permission: 'sending' }) })
    const response = await GET(
      new Request('http://localhost:3001/api/v1/api-keys', { headers: auth }),
    )
    expect(response.status).toBe(403)
  })
})

describe('POST /api/v1/api-keys', () => {
  it('makes a key, sends SQL only its prefix and hash, and answers the key once', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      api_create_key: (body) => ({ ok: true, key: { ...ROW, prefix: body.p_prefix } }),
    })
    const response = await create({ name: 'Billing', permission: 'sending', domain_id: DOMAIN })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(isApiKey(body.key)).toBe(true)
    expect(body).toMatchObject({
      object: 'api_key',
      id: NEW_ID,
      permission: 'sending',
      domain_id: DOMAIN,
    })
    expect(body.prefix).toBe(body.key.slice(0, 13))

    const sent = calls[1]?.body as Record<string, unknown>
    expect(sent).toEqual({
      p_account_id: ACCOUNT,
      p_actor_key_id: KEY_ID,
      p_name: 'Billing',
      p_permission: 'sending',
      p_prefix: body.prefix,
      p_key_hash: await hashApiKey(body.key, PEPPER),
      p_domain_id: DOMAIN,
    })
    // MR7, N13: the new key never reaches the database or a log line.
    expect(JSON.stringify(calls)).not.toContain(body.key)
    expect(JSON.stringify(info.mock.calls)).not.toContain(body.key)
  })

  it('refuses a full key limited to a domain, or no permission, before SQL', async () => {
    const calls = mockRpc({ authenticate_key: () => FULL })
    const limited = await create({ name: 'x', permission: 'full', domain_id: DOMAIN })
    expect(limited.status).toBe(422)
    expect((await limited.json()).message).toContain('domain_id')
    expect((await create({ name: 'x' })).status).toBe(422)
    expect(calls.every((call) => call.fn === 'authenticate_key')).toBe(true)
  })

  it('answers SQL’s refusal: another account’s domain, or a closed account', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      api_create_key: () => ({ ok: false, code: 'validation', field: 'domain' }),
    })
    const domain = await create({ name: 'x', permission: 'sending', domain_id: DOMAIN })
    expect(domain.status).toBe(422)
    expect((await domain.json()).message).toContain('domain_id')
    mockRpc({
      authenticate_key: () => FULL,
      api_create_key: () => ({ ok: false, code: 'account_closed' }),
    })
    expect((await create({ name: 'x', permission: 'full' })).status).toBe(403)
  })
})

describe('DELETE /api/v1/api-keys/{id}', () => {
  it('revokes the key', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      api_revoke_key: () => ({ ok: true, keyId: NEW_ID }),
    })
    const response = await revoke(NEW_ID)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: 'api_key', id: NEW_ID, revoked: true })
    expect(calls[1]?.body).toEqual({
      p_account_id: ACCOUNT,
      p_actor_key_id: KEY_ID,
      p_key_id: NEW_ID,
    })
  })

  it('answers 404 for another account’s key or an id that is not one', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      api_revoke_key: () => ({ ok: false, code: 'not_found' }),
    })
    const response = await revoke(NEW_ID)
    expect(response.status).toBe(404)
    expect((await response.json()).message).toContain('No API key with that id')
    expect((await revoke('42')).status).toBe(404)
  })

  it('answers 403 when SQL finds the key making the request is not full access', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      api_revoke_key: () => ({ ok: false, code: 'forbidden' }),
    })
    expect((await revoke(NEW_ID)).status).toBe(403)
  })
})
