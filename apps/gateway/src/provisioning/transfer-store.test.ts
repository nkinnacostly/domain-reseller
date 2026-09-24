import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createSupabaseStore, toClaimedJob } from './store'

/** The store's transfer calls (migration 26); the functions themselves are in transfer.db.test.ts. */
function fakeClient(answer: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: { fn: string; args: unknown }[] = []
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const DOMAIN = {
  registeredAt: null,
  expiresAt: '2027-03-01T10:00:00.000Z',
  nameservers: ['ns1.example-host.com', 'ns2.example-host.com'],
  transferLock: false,
  privacy: false,
  status: 'Active',
}

describe('Supabase job store — transfers in', () => {
  it('hands a transfer job its code and when it was submitted', () => {
    const job = toClaimedJob({
      id: 'j1',
      kind: 'transfer_domain',
      attempts: 1,
      test_mode: true,
      domain_id: 'd1',
      domain_name: 'getpaid.com',
      local_status: 'transfer_requested',
      privacy: false,
      registrant: null,
      pending_nameservers: null,
      period_years: 1,
      auth_code: 'code-1',
      submitted_at: null,
    })
    expect(job).toMatchObject({ kind: 'transfer_domain', authCode: 'code-1', submittedAt: null })
  })

  it('reads a job from before transfers as having neither', () => {
    const job = toClaimedJob({
      id: 'j1',
      kind: 'register_domain',
      attempts: 1,
      test_mode: true,
      domain_id: 'd1',
      domain_name: 'getpaid.com',
      local_status: 'pending',
      privacy: false,
      registrant: null,
      pending_nameservers: null,
      period_years: 1,
    })
    expect(job).toMatchObject({ authCode: null, submittedAt: null })
  })

  it('marks a transfer submitted with when to poll', async () => {
    const { client, calls } = fakeClient({})
    await createSupabaseStore(client).markTransferSubmitted('j1', 900)
    expect(calls).toEqual([
      { fn: 'mark_transfer_submitted', args: { p_job_id: 'j1', p_poll_after_seconds: 900 } },
    ])
  })

  it('records a completed transfer with what the registry holds', async () => {
    const { client, calls } = fakeClient({})
    await expect(createSupabaseStore(client).completeTransfer('j1', DOMAIN, true)).resolves.toBe(
      'recorded',
    )
    expect(calls).toEqual([
      {
        fn: 'complete_transfer',
        args: {
          p_job_id: 'j1',
          p_registered_at: null,
          p_expires_at: '2027-03-01T10:00:00.000Z',
          p_nameservers: DOMAIN.nameservers,
          p_transfer_lock: false,
          p_privacy: false,
          p_recovered: true,
        },
      },
    ])
  })

  it('says so when another account here holds the name, instead of throwing', async () => {
    const { client } = fakeClient({
      error: { code: '23505', message: 'duplicate key value violates "domains_held_name_unique"' },
    })
    await expect(createSupabaseStore(client).completeTransfer('j1', DOMAIN, false)).resolves.toBe(
      'held_elsewhere',
    )
  })

  it('throws on any other refusal, so the job is left for its lease', async () => {
    const { client } = fakeClient({ error: { code: 'P0001', message: 'job j1 is queued' } })
    const store = createSupabaseStore(client)
    await expect(store.completeTransfer('j1', DOMAIN, false)).rejects.toThrow('job j1 is queued')
    await expect(store.markTransferSubmitted('j1', 900)).rejects.toThrow('job j1 is queued')
  })
})
