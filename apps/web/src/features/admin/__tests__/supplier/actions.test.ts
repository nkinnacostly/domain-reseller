import { HttpResponse, http } from 'msw'
import { revalidateTag } from 'next/cache'
import { cookies, headers } from 'next/headers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPriceList,
  applySslList,
  correctTopup,
  previewPriceList,
  previewSslList,
  recordTopup,
} from '@/features/admin/actions/supplier'
import { ADMIN_ERROR_WORDS, SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../../tests/mocks/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { TRACE } from './fixtures'

vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('GATEWAY_ADMIN_SECRET', 'admin-secret-value-0123456789abcdef')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const BASE = 'http://gateway.test/v1'
const KEY = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a'

type Seen = { url: URL; method: string; headers: Headers }

function capture(method: 'get' | 'post', path: string, reply?: () => Response) {
  const seen: Seen[] = []
  server.use(
    http[method](`${BASE}/${path}`, ({ request }) => {
      seen.push({ url: new URL(request.url), method: request.method, headers: request.headers })
      return reply?.() ?? HttpResponse.json({ ok: true, data: { read: true } })
    }),
  )
  return seen
}

/** The owner, with SQL's answers by function name. */
function owner(
  rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc'] = {},
  verify?: unknown,
) {
  const session = sessionClient({
    rpc: {
      admin_whoami: { data: whoami({ role: 'owner', label: 'owner' }) },
      admin_note: { data: { ok: true, auditId: 51 } },
      ...rpc,
    },
    ...(verify ? { verify: verify as never } : {}),
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'test' }), set: vi.fn() } as never)
})

describe('previewing a price list (D19, D22)', () => {
  it('writes a global note naming the list, then asks the gateway with its id', async () => {
    const session = owner()
    const seen = capture('get', 'admin/supplier/catalogue/preview')

    const result = await previewPriceList({})

    expect(session.rpc).toHaveBeenCalledWith('admin_note', {
      p_action: 'supplier.catalogue_preview',
      p_side: 'global',
      p_target_type: 'catalogue',
      p_target_id: 'tlds',
      p_detail: {},
    })
    expect(seen[0]?.headers.get('x-admin-audit-id')).toBe('51')
    expect(seen[0]?.headers.get('x-admin-label')).toBe('owner')
    // A catalogue read is about the storefront, not a side.
    expect(seen[0]?.url.searchParams.has('side')).toBe(false)
    expect(result.data).toEqual({ ok: true, auditId: 51, data: { read: true } })
  })

  it('names the SSL product list for its own note', async () => {
    const session = owner()
    capture('get', 'admin/supplier/ssl-catalogue/preview')
    await previewSslList({})
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_note',
      expect.objectContaining({ p_action: 'supplier.ssl_catalogue_preview', p_target_id: 'ssl' }),
    )
  })

  it('stops when SQL refuses the note: the gateway is never asked', async () => {
    owner({ admin_note: { data: { ok: false, code: 'TEST_ADMIN', auditId: 52 } } })
    const seen = capture('get', 'admin/supplier/catalogue/preview')
    const result = await previewPriceList({})
    expect(seen).toHaveLength(0)
    expect(result.data).toMatchObject({ ok: false, code: 'TEST_ADMIN', auditId: 52 })
  })

  it("words the gateway's refusal of the note by its reason, and its own refusals", async () => {
    owner()
    capture('get', 'admin/supplier/catalogue/preview', () =>
      HttpResponse.json(
        { ok: false, code: 'ADMIN_NOTE_REFUSED', reason: 'USED', message: 'refused' },
        { status: 403 },
      ),
    )
    expect((await previewPriceList({})).data).toMatchObject({ ok: false, code: 'USED' })

    capture('get', 'admin/supplier/catalogue/preview', () =>
      HttpResponse.json({ ok: false, code: 'NO_SUPPLIER_KEY', message: 'no' }, { status: 503 }),
    )
    expect((await previewPriceList({})).data).toMatchObject({
      ok: false,
      code: 'NO_SUPPLIER_KEY',
      message: "The gateway isn't set up to read this.",
    })
  })

  it('answers the crash words when SQL fails in a way it did not explain', async () => {
    owner({ admin_note: { error: { message: 'fetch failed' } } })
    expect((await previewPriceList({})).serverError).toBe(SERVER_CRASH_WORDS)
  })

  it('is not offered to an operator: the role is checked before any note', async () => {
    const session = sessionClient({
      rpc: { admin_whoami: { data: whoami({ role: 'operator' }) } },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    const result = await previewPriceList({})
    expect(result.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(session.rpc).not.toHaveBeenCalledWith('admin_note', expect.anything())
  })
})

describe('applying a price list (money, owner)', () => {
  const input = { code: '123456', requestKey: KEY }

  it('checks the code against this session’s factor before any note', async () => {
    const session = owner()
    capture('post', 'admin/supplier/catalogue/apply', () =>
      HttpResponse.json({
        ok: true,
        data: { outcome: 'applied', reason: null, changes: 3, readAt: '2026-10-03T13:00:00Z' },
      }),
    )

    const result = await applyPriceList({ ...input, reason: 'Supplier changed .com today' })

    expect(session.challengeAndVerify).toHaveBeenCalledWith({
      factorId: whoami().factorId,
      code: '123456',
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
    expect(session.rpc).toHaveBeenCalledWith('admin_note', {
      p_action: 'supplier.catalogue_apply',
      p_side: 'global',
      p_target_type: 'catalogue',
      p_target_id: 'tlds',
      p_detail: {},
      p_reason: 'Supplier changed .com today',
      p_request_key: KEY,
    })
    expect(result.data).toMatchObject({ ok: true, auditId: 51, data: { changes: 3 } })
    // Site prices are cached under `pricing`: expired now, so they update (N5b).
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })

  it('refuses a wrong code with no note, no gateway call and nothing expired', async () => {
    const session = owner(
      {},
      { error: { message: 'Invalid TOTP code', code: 'mfa_verification_failed' } },
    )
    const seen = capture('post', 'admin/supplier/catalogue/apply')
    const result = await applyPriceList(input)
    expect(result.serverError).toBe(
      "That code didn't work. Check your authenticator app and try again.",
    )
    expect(session.rpc).not.toHaveBeenCalledWith('admin_note', expect.anything())
    expect(seen).toHaveLength(0)
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('is a refusal when the sync refused the listing: nothing written, nothing expired', async () => {
    owner()
    capture('post', 'admin/supplier/ssl-catalogue/apply', () =>
      HttpResponse.json({
        ok: true,
        data: { outcome: 'refused', reason: 'too many retired', changes: 0, readAt: 'x' },
      }),
    )
    const result = await applySslList(input)
    expect(result.data).toEqual({
      ok: false,
      code: 'CATALOGUE_REFUSED',
      message: 'The sync refused the listing, so nothing was written: too many retired.',
      auditId: 51,
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('words the sandbox gateway, which never applies a price list', async () => {
    owner()
    capture('post', 'admin/supplier/catalogue/apply', () =>
      HttpResponse.json({ ok: false, code: 'NOT_PRODUCTION', message: 'no' }, { status: 503 }),
    )
    expect((await applyPriceList(input)).data).toMatchObject({
      ok: false,
      code: 'NOT_PRODUCTION',
      message: 'Only the production gateway applies the price list.',
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('needs the six digits and a request key before anything runs', async () => {
    const session = owner()
    const result = await applyPriceList({ code: '12', requestKey: 'nope' })
    expect(result.validationErrors).toBeDefined()
    expect(session.rpc).not.toHaveBeenCalled()
  })
})

describe('top-up costs (money, owner; §3.2b)', () => {
  const record = {
    traceId: TRACE.toUpperCase(),
    ngnPaidKobo: 5_832_000,
    reference: '  GTB-0042  ',
    reason: 'Paid by transfer on 1 Oct',
    requestKey: KEY,
    code: '123456',
  }

  it('records the naira paid for a live ledger credit through its wrapper, as the admin', async () => {
    const session = owner({ admin_record_float_topup: { data: { ok: true, auditId: 60 } } })
    const result = await recordTopup(record)
    expect(session.challengeAndVerify).toHaveBeenCalledTimes(1)
    expect(session.rpc).toHaveBeenCalledWith('admin_record_float_topup', {
      p_trace_id: TRACE,
      p_ngn_paid_kobo: 5_832_000,
      p_reference: 'GTB-0042',
      p_reason: 'Paid by transfer on 1 Oct',
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 60 })
  })

  it('words the wrapper’s refusals in the shared words, none of them about a refund', async () => {
    owner({ admin_record_float_topup: { data: { ok: false, code: 'BAD_REFERENCE', auditId: 61 } } })
    expect((await recordTopup(record)).data).toEqual({
      ok: false,
      code: 'BAD_REFERENCE',
      message: ADMIN_ERROR_WORDS.BAD_REFERENCE,
      auditId: 61,
    })
    expect(ADMIN_ERROR_WORDS.BAD_REFERENCE).not.toMatch(/refund/i)
    owner({
      admin_record_float_topup: { data: { ok: false, code: 'ALREADY_RECORDED', auditId: 62 } },
    })
    expect((await recordTopup(record)).data).toMatchObject({
      ok: false,
      message: "This top-up's cost is already recorded. Correct it instead.",
    })
  })

  it('answers the crash words when the wrapper call fails unexplained, so the key is kept', async () => {
    owner({ admin_record_float_topup: { error: { message: 'fetch failed' } } })
    expect((await recordTopup(record)).serverError).toBe(SERVER_CRASH_WORDS)
    owner({ admin_record_float_topup: { error: { message: 'admin:role' } } })
    expect((await recordTopup(record)).serverError).toBe(
      "Your admin role can't do this. Ask the owner.",
    )
  })

  it('validates first: no trace id, no money in kobo, no reason — no call', async () => {
    const session = owner()
    for (const bad of [
      { ...record, traceId: 'example.com' },
      { ...record, ngnPaidKobo: 58_320.5 },
      { ...record, ngnPaidKobo: 0 },
      { ...record, reference: '' },
      { ...record, reason: 'short' },
    ]) {
      expect((await recordTopup(bad)).validationErrors, JSON.stringify(bad)).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('corrects a current record with a superseding one', async () => {
    const session = owner({ admin_correct_float_topup: { data: { ok: true, auditId: 70 } } })
    const result = await correctTopup({
      topupId: 7,
      ngnPaidKobo: 5_900_000,
      reference: 'GTB-0043',
      reason: 'Bank fee was left out',
      requestKey: KEY,
      code: '123456',
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_correct_float_topup', {
      p_topup_id: 7,
      p_ngn_paid_kobo: 5_900_000,
      p_reference: 'GTB-0043',
      p_reason: 'Bank fee was left out',
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 70 })
    owner({ admin_correct_float_topup: { error: { message: 'timeout' } } })
    expect(
      (
        await correctTopup({
          topupId: 7,
          ngnPaidKobo: 5_900_000,
          reference: 'GTB-0043',
          reason: 'Bank fee was left out',
          requestKey: KEY,
          code: '123456',
        })
      ).serverError,
    ).toBe(SERVER_CRASH_WORDS)
  })
})
