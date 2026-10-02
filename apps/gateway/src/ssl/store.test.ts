import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createSslStore, toClaimedSslJob } from './store'

/** The thin store: which function, with what. The functions are checked in supabase/tests/ssl_certificates.sql. */

function fakeClient(
  answer: { data?: unknown; error?: { message: string; code?: string } | null } = {},
) {
  const calls: { fn: string; args: unknown }[] = []
  const result = { data: answer.data ?? null, error: answer.error ?? null }
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve(result)
    },
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ fn: `insert:${table}`, args: row })
        return Promise.resolve(result)
      },
    }),
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const ROW = {
  id: 'j1',
  kind: 'ssl_initialize',
  attempts: 1,
  test_mode: true,
  sent_at: null,
  certificate_id: 'c1',
  common_name: '*.example.com',
  product_code: '352',
  is_wildcard: true,
  included_names: 1,
  status: 'pending',
  csr: null,
  approver_email: null,
  web_server: null,
  san_names: null,
  contact: null,
  name_taken: false,
  payment: {
    order_tx_ref: 'MDH-1',
    order_total_kobo: '1451250',
    reference: '900001',
    amount_kobo: 1451250,
    currency: 'NGN',
    status: 'successful',
  },
}

describe('the SSL store', () => {
  it('claims a job with its charge, or one job by id', async () => {
    const { client, calls } = fakeClient({ data: ROW })
    const store = createSslStore(client)
    const job = await store.claim('w', true, 300)
    expect(job).toEqual(toClaimedSslJob(ROW))
    expect(job?.payment).toEqual({
      orderTxRef: 'MDH-1',
      orderTotalKobo: 1451250,
      reference: '900001',
      amountKobo: 1451250,
      currency: 'NGN',
      status: 'successful',
    })
    expect(job?.sanNames).toEqual([])
    await store.claim('w', false, 60, 'j9')
    expect(calls).toEqual([
      { fn: 'claim_ssl_job', args: { p_worker: 'w', p_test_mode: true, p_lease_seconds: 300 } },
      {
        fn: 'claim_ssl_job',
        args: { p_worker: 'w', p_test_mode: false, p_lease_seconds: 60, p_job_id: 'j9' },
      },
    ])
  })

  it('reads a claim without a charge, and returns nothing when nothing is due', async () => {
    expect(toClaimedSslJob({ ...ROW, payment: null, name_taken: true }).payment).toBeNull()
    expect(
      toClaimedSslJob({
        ...ROW,
        payment: { ...ROW.payment, amount_kobo: null, order_tx_ref: null, order_total_kobo: null },
      }).payment,
    ).toMatchObject({
      orderTxRef: '',
      orderTotalKobo: 0,
      amountKobo: null,
    })
    const { client } = fakeClient({ data: null })
    await expect(createSslStore(client).claim('w', true, 300)).resolves.toBeNull()
  })

  it('records a call against its SSL job, without a body', async () => {
    const { client, calls } = fakeClient()
    await createSslStore(client).recordCall('j1', 'ote', {
      operation: 'SslInitialize',
      domainName: 'example.com',
      outcome: 'ok',
      httpStatus: 200,
      errorCode: null,
      message: null,
      durationMs: 12,
    })
    expect(calls[0]).toEqual({
      fn: 'insert:supplier_calls',
      args: {
        ssl_job_id: 'j1',
        environment: 'ote',
        operation: 'SslInitialize',
        domain_name: 'example.com',
        outcome: 'ok',
        http_status: 200,
        error_code: null,
        message: null,
        duration_ms: 12,
      },
    })
  })

  it('calls each queue function with its arguments', async () => {
    const { client, calls } = fakeClient({ data: '2026-10-02T12:00:00Z' })
    const store = createSslStore(client)
    await expect(store.noteSent('j1')).resolves.toBe('2026-10-02T12:00:00Z')
    await expect(
      store.completeInitialize(
        'j1',
        {
          certificateId: null,
          supplierStatus: 'WaitingForInstall',
          purchasedAt: null,
          subscriptionEndsAt: null,
        },
        true,
      ),
    ).resolves.toBe('recorded')
    await store.recordConfigured('j1', 'WaitingForValidation', false)
    await store.refuseSetup('j1', 'CSR_INVALID', 'bad')
    await store.recordReissue('j1', 'WaitingForValidation', 'awaiting_validation', true)
    await store.reschedule('j1', 30, 'TIMEOUT', 'slow')
    await store.fail('j1', 'SSL_REFUSED', 'no', false)
    await store.recordStatus('c1', {
      supplierStatus: 'Active',
      state: 'issued',
      issuedAt: null,
      expiresAt: '2027-04-20T00:00:00Z',
      certificate: 'PEM',
      caBundle: null,
      nextCheckSeconds: 3600,
    })
    expect(calls.map((call) => call.fn)).toEqual([
      'note_ssl_job_sent',
      'complete_ssl_initialize',
      'record_ssl_configured',
      'refuse_ssl_setup',
      'record_ssl_reissue',
      'reschedule_ssl_job',
      'fail_ssl_job',
      'record_ssl_status',
    ])
    expect(calls[1]?.args).toEqual({
      p_job_id: 'j1',
      p_supplier_id: null,
      p_supplier_status: 'WaitingForInstall',
      p_purchased_at: null,
      p_subscription_ends_at: null,
      p_recovered: true,
    })
    expect(calls[7]?.args).toEqual({
      p_certificate_id: 'c1',
      p_supplier_status: 'Active',
      p_state: 'issued',
      p_issued_at: null,
      p_expires_at: '2027-04-20T00:00:00Z',
      p_certificate: 'PEM',
      p_ca_bundle: null,
      p_next_check_seconds: 3600,
    })
  })

  it('says when another certificate here holds the name, and passes other errors on', async () => {
    const held = fakeClient({ error: { message: 'duplicate key', code: '23505' } })
    const bought = {
      certificateId: null,
      supplierStatus: 'x',
      purchasedAt: null,
      subscriptionEndsAt: null,
    }
    await expect(createSslStore(held.client).completeInitialize('j1', bought, false)).resolves.toBe(
      'name_held_here',
    )
    const broken = fakeClient({ error: { message: 'boom' } })
    const store = createSslStore(broken.client)
    await expect(store.completeInitialize('j1', bought, false)).rejects.toThrow('boom')
    await expect(store.claim('w', true, 1)).rejects.toThrow('boom')
    await expect(store.noteSent('j1')).rejects.toThrow('boom')
    await expect(store.fail('j1', 'x', 'y', true)).rejects.toThrow('boom')
    await expect(store.toCheck(true, 5)).rejects.toThrow('boom')
  })

  it('lists certificates to check', async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          id: 'c1',
          common_name: 'example.com',
          status: 'awaiting_validation',
          is_wildcard: false,
          configured_at: null,
          has_certificate: false,
        },
      ],
    })
    await expect(createSslStore(client).toCheck(true, 5)).resolves.toEqual([
      {
        id: 'c1',
        commonName: 'example.com',
        status: 'awaiting_validation',
        isWildcard: false,
        configuredAt: null,
        hasCertificate: false,
      },
    ])
    expect(calls[0]).toEqual({
      fn: 'ssl_certificates_to_check',
      args: { p_test_mode: true, p_limit: 5 },
    })
    const empty = fakeClient({ data: null })
    await expect(createSslStore(empty.client).toCheck(false, 5)).resolves.toEqual([])
  })
})
