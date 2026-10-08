import { describe, expect, it } from 'vitest'
import { createRelayStore, type MailClient, StoreError } from './store'

/** What the store sends and how it reads the answers; the functions are proven in SQL. */
function fakeClient(answer: { data?: unknown; error?: { code: string } } = {}) {
  const calls: { schema: string; fn: string; args: unknown }[] = []
  const rpc = (schema: string) => (fn: string, args: unknown) => {
    calls.push({ schema, fn, args })
    return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
  }
  const client = { rpc: rpc('mail'), schema: (name: string) => ({ rpc: rpc(name) }) }
  return { client: client as unknown as MailClient, calls }
}

const KEY = {
  ok: true,
  keyId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  accountId: '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e',
  permission: 'full',
  domainId: null,
}
const EMAIL = {
  email: {
    from: 'a@acme.example',
    to: ['b@example.com'],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: 'Hi',
    tags: [],
  },
  payload: { html: null, text: 'Hi', headers: {}, attachments: [] },
}

describe('the relay’s store', () => {
  it('checks a key by its hash, and passes on a refusal', async () => {
    const accepted = fakeClient({ data: KEY })
    expect(await createRelayStore(accepted.client).authenticateKey('h'.repeat(64))).toEqual({
      ok: true,
      key: { keyId: KEY.keyId, accountId: KEY.accountId, permission: 'full', domainId: null },
    })
    expect(accepted.calls).toEqual([
      { schema: 'mail', fn: 'authenticate_key', args: { p_key_hash: 'h'.repeat(64) } },
    ])
    const refused = fakeClient({ data: { ok: false, code: 'unauthorized' } })
    expect(await createRelayStore(refused.client).authenticateKey('x')).toEqual({
      ok: false,
      code: 'unauthorized',
    })
  })

  it('queues with the Idempotency-Key only when both it and the fingerprint are there', async () => {
    const { client, calls } = fakeClient({
      data: {
        ok: true,
        id: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d',
        status: 'queued',
        replayed: true,
      },
    })
    const store = createRelayStore(client)
    const base = { accountId: KEY.accountId, keyId: KEY.keyId, email: EMAIL }
    expect(
      await store.enqueueEmail({ ...base, idempotencyKey: 'smtp-1', requestHash: 'f'.repeat(64) }),
    ).toMatchObject({
      ok: true,
      replayed: true,
    })
    await store.enqueueEmail({ ...base, idempotencyKey: null, requestHash: null })
    expect(calls.map((call) => Object.keys(call.args as object).sort())).toEqual([
      [
        'p_account_id',
        'p_api_key_id',
        'p_email',
        'p_idempotency_key',
        'p_payload',
        'p_request_hash',
      ],
      ['p_account_id', 'p_api_key_id', 'p_email', 'p_payload'],
    ])
  })

  it('throws on a database error or an answer it does not know; beats in public', async () => {
    const failed = fakeClient({ error: { code: 'PGRST301' } })
    await expect(createRelayStore(failed.client).authenticateKey('x')).rejects.toBeInstanceOf(
      StoreError,
    )
    const odd = fakeClient({ data: { surprise: true } })
    await expect(createRelayStore(odd.client).authenticateKey('x')).rejects.toThrow(
      'unexpected_answer',
    )
    const beat = fakeClient()
    await createRelayStore(beat.client).heartbeat('mail-worker:smtp', { accepted: 2 })
    expect(beat.calls).toEqual([
      {
        schema: 'public',
        fn: 'record_heartbeat',
        args: { p_name: 'mail-worker:smtp', p_test_mode: false, p_detail: { accepted: 2 } },
      },
    ])
    const down = fakeClient({ error: { code: '500' } })
    await expect(createRelayStore(down.client).heartbeat('x', {})).rejects.toBeInstanceOf(
      StoreError,
    )
  })
})
