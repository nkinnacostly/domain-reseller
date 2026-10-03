import { describe, expect, it, vi } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createAdminStore, createNoteStore } from './notes'

/** The audit trail's gateway side (migration 40): claim, result, and the few admin writes. */

function tableClient(rows: { data?: unknown; error?: { message: string } | null }) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit', 'in'])
    builder[method] = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => rows)
  builder.insert = vi.fn(async () => ({ error: rows.error ?? null }))
  const from = vi.fn(() => builder)
  return { from, builder }
}

describe('the note store', () => {
  it('claims a note and says why one was refused', async () => {
    const { client, rpc } = fakeRpcClient({ admin_claim_note: { data: { ok: true } } })
    const notes = createNoteStore(client)
    expect(await notes.claim(41, 'supplier.balance', 'owner', 'test', 'test')).toEqual({
      ok: true,
      detail: {},
    })
    expect(rpc).toHaveBeenCalledWith('admin_claim_note', {
      p_audit_id: 41,
      p_action: 'supplier.balance',
      p_label: 'owner',
      p_side: 'test',
      p_target_id: 'test',
    })
    const refused = createNoteStore(
      fakeRpcClient({ admin_claim_note: { data: { ok: false, code: 'USED' } } }).client,
    )
    expect(await refused.claim(41, 'supplier.balance', 'owner', 'test', 'test')).toEqual({
      ok: false,
      code: 'USED',
    })
    // The note's detail comes back with the claim (D23); anything else is none.
    const noted = createNoteStore(
      fakeRpcClient({
        admin_claim_note: { data: { ok: true, detail: { refund_id: 'abc' } } },
      }).client,
    )
    expect(await noted.claim(41, 'refund.flw_check', 'owner', 'test', '123')).toEqual({
      ok: true,
      detail: { refund_id: 'abc' },
    })
    const listed = createNoteStore(
      fakeRpcClient({ admin_claim_note: { data: { ok: true, detail: ['x'] } } }).client,
    )
    expect(await listed.claim(41, 'supplier.balance', 'owner', 'test', 'test')).toEqual({
      ok: true,
      detail: {},
    })
    const blank = createNoteStore(fakeRpcClient({}).client)
    expect(await blank.claim(41, 'supplier.balance', 'owner', 'test', 'test')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('records one result, an empty code for none', async () => {
    const { client, rpc } = fakeRpcClient()
    await createNoteStore(client).result(41, 'ok', null, { cents: 4338 })
    expect(rpc).toHaveBeenCalledWith('admin_note_result', {
      p_audit_id: 41,
      p_outcome: 'ok',
      p_code: '',
      p_detail: { cents: 4338 },
    })
  })

  it('throws what the database refused', async () => {
    const { client } = fakeRpcClient({ admin_claim_note: { error: { message: 'no grant' } } })
    await expect(
      createNoteStore(client).claim(1, 'supplier.balance', 'owner', 'test', 'test'),
    ).rejects.toThrow('no grant')
  })
})

describe('the admin store', () => {
  it('records a supplier call with identifiers and outcome only', async () => {
    const { from, builder } = tableClient({})
    await createAdminStore({ from } as never).recordCall('ote', {
      operation: 'AdminTransferQuery',
      domainName: 'example.com',
      outcome: 'ok',
      httpStatus: 200,
      errorCode: null,
      message: 'rejected',
      durationMs: 120,
    })
    expect(from).toHaveBeenCalledWith('supplier_calls')
    expect(builder.insert).toHaveBeenCalledWith({
      job_id: null,
      environment: 'ote',
      operation: 'AdminTransferQuery',
      domain_name: 'example.com',
      outcome: 'ok',
      http_status: 200,
      error_code: null,
      message: 'rejected',
      duration_ms: 120,
    })
  })

  it('records a Flutterwave check for a claimed note', async () => {
    const { client, rpc } = fakeRpcClient({ record_flw_refund_check: { data: '9' } })
    const id = await createAdminStore(client).recordFlwCheck({
      auditId: 41,
      testMode: true,
      targetType: 'refund',
      targetId: 'r1',
      flwRefundId: '123',
      transactionId: null,
      amountKobo: 100,
      status: 'completed',
      disburseStatus: null,
      state: 'pending',
    })
    expect(id).toBe(9)
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_tx_id: '',
      p_disburse_status: '',
      p_state: 'pending',
    })
  })

  it('reads an extension’s cost, and none for an unknown one', async () => {
    const found = tableClient({
      data: {
        register_usd: '99.9000',
        renew_usd: '99.9000',
        transfer_usd: null,
        restore_usd: '40',
        register_periods: [2, 4],
        min_period: 2,
      },
    })
    expect(await createAdminStore({ from: found.from } as never).tldCost('ai')).toEqual({
      registerUsd: 99.9,
      renewUsd: 99.9,
      transferUsd: null,
      restoreUsd: 40,
      firstTermYears: 2,
    })
    const missing = tableClient({ data: null })
    expect(await createAdminStore({ from: missing.from } as never).tldCost('zz')).toBeNull()
    const broken = tableClient({ data: null, error: { message: 'down' } })
    await expect(createAdminStore({ from: broken.from } as never).tldCost('zz')).rejects.toThrow(
      'down',
    )
  })

  it('finds an open draft due a check', async () => {
    const { client } = fakeRpcClient({
      preset_drafts_for_check: {
        data: [{ draft_id: 'd1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] }],
      },
    })
    const store = createAdminStore(client)
    expect(await store.draft('d1')).toEqual({
      id: 'd1',
      provider: 'Vercel',
      nameservers: ['ns1.vercel-dns.com'],
    })
    expect(await store.draft('d2')).toBeNull()
  })
})
