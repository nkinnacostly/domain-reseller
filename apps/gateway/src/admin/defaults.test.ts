import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { adminDepsFor, createDefaultAdminRouter } from './defaults'

/** The admin router's wiring: what exists on which gateway, built without touching the network. */

const BASE = {
  GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
  DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
  DNA_API_KEY: 'x',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'x',
}
const flw = (key: string) => ({ FLUTTERWAVE_SECRET_KEY: key })

function fakeClient() {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit', 'in'])
    builder[method] = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
  builder.insert = vi.fn(async () => ({ error: null }))
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'admin_claim_note' ? { ok: true } : name === 'preset_drafts_for_check' ? [] : null,
    error: null,
  }))
  return { client: { rpc, from: vi.fn(() => builder) } as never, rpc }
}

describe('admin wiring', () => {
  it('reads no side, and no catalogue, on a laptop with writes off', () => {
    const deps = adminDepsFor(parseEnv(BASE))
    expect(deps.secret).toBeUndefined()
    expect(deps.target).toBe('off')
    expect(deps.targetSupplier()).toBeNull()
    expect(deps.lookup()).toBeNull()
    expect(deps.ssl()).toBeNull()
    expect(deps.flutterwave()).toBeNull()
    expect(deps.catalogue()).toBeNull()
    expect(deps.sslCatalogue()).toBeNull()
    // DNA_ENV defaults to the sandbox, which needs its own key.
    expect(deps.catalogueSupplier()).toBeNull()
  })

  it('reads the sandbox side with the sandbox key', () => {
    const env = parseEnv({
      ...BASE,
      ...flw('FLWSECK_TEST-0000000000000000-X'),
      DNA_WRITE_ENV: 'ote',
      DNA_API_TEST_KEY: 'ote-key',
      GATEWAY_ADMIN_SECRET: 'z'.repeat(32),
    })
    const deps = adminDepsFor(env)
    expect(deps.secret).toBe('z'.repeat(32))
    expect(deps.targetSupplier()?.environment).toBe('ote')
    expect(deps.targetSupplier()).toBe(deps.targetSupplier())
    expect(typeof deps.lookup).toBe('function')
    expect(deps.ssl()).not.toBeNull()
    expect(deps.flutterwave()).not.toBeNull()
    expect(deps.catalogueSupplier()?.environment).toBe('ote')
    expect(deps.catalogue()).toBeNull()
  })

  it('previews the live catalogue anywhere it is read, and refuses to apply outside production', async () => {
    const deps = adminDepsFor(parseEnv({ ...BASE, DNA_ENV: 'production' }), {
      client: fakeClient().client,
    })
    const catalogue = deps.catalogue()
    expect(catalogue).not.toBeNull()
    expect(await catalogue?.apply()).toMatchObject({ outcome: 'refused' })
    expect(await deps.sslCatalogue()?.apply()).toMatchObject({ outcome: 'refused' })
  })

  it('reaches the database through the notes and the store', async () => {
    const { client, rpc } = fakeClient()
    const deps = adminDepsFor(parseEnv(BASE), { client })
    expect(await deps.notes.claim(1, 'supplier.balance', 'owner', 'test', 'test')).toEqual({
      ok: true,
      detail: {},
    })
    await deps.notes.result(1, 'ok', null, {})
    await deps.store.recordCall('ote', {
      operation: 'AdminGetDetails',
      domainName: 'x.com',
      outcome: 'ok',
      httpStatus: 200,
      errorCode: null,
      message: null,
      durationMs: 1,
    })
    expect(await deps.store.tldCost('com')).toBeNull()
    expect(await deps.store.draft('d1')).toBeNull()
    await deps.store.recordFlwCheck({
      auditId: 1,
      testMode: true,
      targetType: 'refund',
      targetId: 'r',
      flwRefundId: 'f',
      transactionId: null,
      amountKobo: 1,
      status: 'completed',
      disburseStatus: null,
      state: 'pending',
    })
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      'admin_claim_note',
      'admin_note_result',
      'preset_drafts_for_check',
      'record_flw_refund_check',
    ])
  })

  it('checks a draft with no hosts without asking any resolver', async () => {
    const deps = adminDepsFor(parseEnv(BASE), { client: fakeClient().client })
    const result = await deps.checkDraft({ id: 'd1', provider: 'X', nameservers: [] })
    expect(result).toMatchObject({ ok: false, hosts: [] })
  })

  it('builds the default router from the process environment', () => {
    expect(createDefaultAdminRouter()).toBeDefined()
  })
})
