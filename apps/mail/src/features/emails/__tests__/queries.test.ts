import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getEmailLog, getEmailPage, LOG_PAGE } from '../queries/log'

/** The log's reads (MAIL-SPEC §10), as the member: what reaches the database, and each failure. */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

type Answer = { data: unknown; error: { code: string } | null }

/** A session client double: each table answers one result, through any chain of filters. */
function fake(tables: Record<string, Answer>, rpc: Answer = { data: null, error: null }) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const rpcCalls: { fn: string; args: unknown }[] = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      }
    }
    const answer = tables[table] ?? { data: null, error: null }
    chain.maybeSingle = async () => answer
    // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited
    chain.then = (resolve: (value: Answer) => unknown) => Promise.resolve(answer).then(resolve)
    return chain
  }
  const client = {
    from,
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      return rpc
    },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return { calls, rpcCalls }
}

const ROW = {
  id: ID,
  from: 'a@acme.example',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: 'Hi',
  tags: [],
  status: 'queued',
  status_reason: null,
  created_at: '2026-10-06T09:00:00.000000Z',
  scheduled_at: '2026-10-06T09:00:00.000000Z',
  sent_at: null,
  delivered_at: null,
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  last_event: null,
  last_event_at: null,
}

const DETAIL = {
  id: 7,
  public_id: ID,
  from_address: 'a@acme.example',
  to_addresses: ['ada@example.com'],
  cc_addresses: [],
  bcc_addresses: [],
  reply_to: [],
  recipient_count: 1,
  subject: 'Hi',
  tags: [{ name: 'kind', value: 'receipt' }],
  status: 'sent',
  status_reason: null,
  ses_message_id: 'ses-1',
  created_at: '2026-10-06T09:00:00Z',
  scheduled_at: '2026-10-06T09:00:00Z',
  sent_at: '2026-10-06T09:00:02Z',
  delivered_at: null,
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
}

beforeEach(() => vi.clearAllMocks())

describe('getEmailLog', () => {
  it('asks account_emails for a page, with the filters in SQL’s names and the cursor', async () => {
    const { rpcCalls } = fake(
      {},
      {
        data: { ok: true, data: [ROW], hasMore: true, next: { at: ROW.created_at, id: ID } },
        error: null,
      },
    )
    const page = await getEmailLog(
      ACCOUNT,
      { to: 'Ada@example.com', tag: 'kind' },
      { at: ROW.created_at, id: ID },
    )
    expect(page).toEqual({ emails: [ROW], next: { at: ROW.created_at, id: ID } })
    expect(rpcCalls).toEqual([
      {
        fn: 'account_emails',
        args: {
          p_account_id: ACCOUNT,
          p_filters: { to: 'ada@example.com', tag_name: 'kind' },
          p_limit: LOG_PAGE,
          p_cursor_at: ROW.created_at,
          p_cursor_id: ID,
        },
      },
    ])
  })

  it('is null — the error state, never "no emails" — when the read fails or is refused', async () => {
    fake({}, { data: null, error: { code: '08006' } })
    expect(await getEmailLog(ACCOUNT, {}, null)).toBeNull()
    fake({}, { data: { ok: false, code: 'not_found' }, error: null })
    expect(await getEmailLog(ACCOUNT, {}, null)).toBeNull()
  })
})

describe('getEmailPage', () => {
  it('reads the account’s email, its events in order, and its body while kept', async () => {
    const { calls } = fake({
      emails: { data: DETAIL, error: null },
      email_events: {
        data: [{ id: 1, type: 'send', occurred_at: '2026-10-06T09:00:02Z', detail: {} }],
        error: null,
      },
      email_payloads: { data: { html: '<p>Hi</p>', text: null, headers: {} }, error: null },
    })
    const page = await getEmailPage(ACCOUNT, ID)
    expect(page).toMatchObject({
      email: { public_id: ID, tags: [{ name: 'kind', value: 'receipt' }] },
      events: [{ type: 'send' }],
      payload: { html: '<p>Hi</p>' },
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        { table: 'emails', method: 'eq', args: ['account_id', ACCOUNT] },
        { table: 'emails', method: 'eq', args: ['public_id', ID] },
        { table: 'email_events', method: 'eq', args: ['email_id', 7] },
        { table: 'email_payloads', method: 'eq', args: ['email_id', 7] },
      ]),
    )
  })

  it('has no body when RLS shows none, or the purge took it', async () => {
    fake({
      emails: { data: DETAIL, error: null },
      email_events: { data: [], error: null },
      email_payloads: { data: null, error: null },
    })
    expect(await getEmailPage(ACCOUNT, ID)).toMatchObject({ payload: null, events: [] })
  })

  it('says missing for an id that is not this account’s, and null when a read fails', async () => {
    fake({ emails: { data: null, error: null } })
    expect(await getEmailPage(ACCOUNT, ID)).toBe('missing')
    fake({ emails: { data: null, error: { code: '08006' } } })
    expect(await getEmailPage(ACCOUNT, ID)).toBeNull()
    fake({ emails: { data: { ...DETAIL, status: 'lost' }, error: null } })
    expect(await getEmailPage(ACCOUNT, ID)).toBeNull()
    fake({
      emails: { data: DETAIL, error: null },
      email_events: { data: null, error: { code: '42501' } },
    })
    expect(await getEmailPage(ACCOUNT, ID)).toBeNull()
    fake({
      emails: { data: DETAIL, error: null },
      email_events: { data: [{ id: 1, type: 'open', occurred_at: 'x', detail: {} }], error: null },
      email_payloads: { data: null, error: null },
    })
    expect(await getEmailPage(ACCOUNT, ID)).toBeNull()
  })
})
