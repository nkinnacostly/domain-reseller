import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/v1/emails/[id]/route'
import { mockRpc } from '../../../../tests/mocks/supabase'

/** GET /api/v1/emails/{id} (§6): the account's own email, its status, never its body (MR3). */

const KEY = `mdh_live_${'Zz9Yy8Xx'.repeat(5)}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const EMAIL_ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'
const FULL = {
  ok: true,
  keyId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  accountId: ACCOUNT,
  permission: 'full',
  domainId: null,
}

const VIEW = {
  id: EMAIL_ID,
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: 'Your receipt',
  tags: [{ name: 'kind', value: 'receipt' }],
  status: 'delivered',
  status_reason: null,
  created_at: '2026-10-06T09:30:00+00:00',
  scheduled_at: '2026-10-06T09:30:00+00:00',
  sent_at: '2026-10-06T09:30:02+00:00',
  delivered_at: '2026-10-06T09:30:04+00:00',
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  last_event: 'delivery',
  last_event_at: '2026-10-06T09:30:04+00:00',
}

const get = (id: string, key = KEY) =>
  GET(
    new Request(`http://localhost:3001/api/v1/emails/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    {
      params: Promise.resolve({ id }),
    },
  )

describe('GET /api/v1/emails/{id}', () => {
  it('answers the email’s status and timestamps, asking for this account’s email only', async () => {
    const calls = mockRpc({ authenticate_key: () => FULL, get_email: () => VIEW })
    const response = await get(EMAIL_ID)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ object: 'email', ...VIEW })
    expect(body).not.toHaveProperty('html')
    expect(calls[1]).toMatchObject({
      fn: 'get_email',
      schema: 'mail',
      body: { p_account_id: ACCOUNT, p_public_id: EMAIL_ID },
    })
  })

  it('answers 404 for another account’s email, or one that never was', async () => {
    mockRpc({ authenticate_key: () => FULL, get_email: () => null })
    const response = await get(EMAIL_ID)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ name: 'not_found' })
  })

  it('answers 404 for an id that is not one, without asking for it', async () => {
    const calls = mockRpc({ authenticate_key: () => FULL })
    expect((await get('42')).status).toBe(404)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })

  it('refuses a sending-only key: reading takes full access', async () => {
    const calls = mockRpc({ authenticate_key: () => ({ ...FULL, permission: 'sending' }) })
    const response = await get(EMAIL_ID)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: 'forbidden' })
    expect(calls).toHaveLength(1)
  })

  it('refuses a missing key', async () => {
    mockRpc({})
    expect((await get(EMAIL_ID, 'nope')).status).toBe(401)
  })

  it('answers internal_error for a view it does not understand', async () => {
    mockRpc({ authenticate_key: () => FULL, get_email: () => ({ id: EMAIL_ID }) })
    expect((await get(EMAIL_ID)).status).toBe(500)
  })
})
