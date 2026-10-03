import { HttpResponse, http } from 'msw'
import { revalidateTag } from 'next/cache'
import { cookies, headers } from 'next/headers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setExtensionFlags } from '@/features/admin/actions/extensions'
import {
  checkPresetDraft,
  discardPresetDraft,
  hidePreset,
  publishPresetDraft,
  savePresetDraft,
  showPreset,
} from '@/features/admin/actions/presets'
import { updateLimits } from '@/features/admin/actions/settings'
import { setSslSellable } from '@/features/admin/actions/ssl-products'
import { SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { server } from '../../../../../tests/mocks/server'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The Settings actions (docs/ADMIN-SPEC.md §3.1.2, §5.2 B13): each is
 * validated, then the role is checked for the words, then — for a money
 * action — the dialog's code is verified against this session's factor
 * before one `admin_*` wrapper is called as the admin. Prices are expired
 * after an extension or SSL change that went through; the preset lists after
 * a publish, hide or show (`revalidateTag('nameserver-presets', { expire: 0 })`).
 */

vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('GATEWAY_ADMIN_SECRET', 'admin-secret-value-0123456789abcdef')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const KEY = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a'
const PRESET = 'd97320b5-50a9-44d4-a881-7b4bc1a5e077'
const DRAFT = '5e1f0a9c-1111-4222-8333-444455556666'
const CODE = '123456'
const FACTOR = '99999999-8888-4777-8666-555555555555'
const REASON = 'Checked against the provider documentation today'

type Rpc = NonNullable<Parameters<typeof sessionClient>[0]>['rpc']

/** The owner, with SQL's answers by function name. */
function owner(rpc: Rpc = {}, verify?: { error: { message: string; code?: string } | null }) {
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role: 'owner', label: 'owner' }) }, ...rpc },
    ...(verify ? { verify } : {}),
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

function asRole(role: 'operator' | 'viewer', extra: Record<string, unknown> = {}, rpc: Rpc = {}) {
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role, label: 'ops', ...extra }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const wrapperCalls = (rpc: ReturnType<typeof sessionClient>['rpc']) =>
  rpc.mock.calls.filter(([name]) => name !== 'admin_whoami').map(([name]) => name)

/** The service client behind adminDb, for the featured-rank read. */
function featured(rows: { name: string; featured_rank: number }[]) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'not', 'order']) builder[method] = () => builder
  // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is a thenable
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve)
  vi.mocked(createServiceClient).mockReturnValue({ from: () => builder } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => undefined, set: vi.fn() } as never)
})

describe('saving limits (settings.update, money, owner)', () => {
  it('verifies the code with this session’s factor, then sends only the changed keys', async () => {
    const session = owner({ admin_update_ops_settings: { data: { ok: true, auditId: 70 } } })
    const result = await updateLimits({
      changes: { refund_delay_minutes: 12, float_alert_cents: 5_000 },
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(session.challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR, code: CODE })
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
    expect(session.rpc).toHaveBeenCalledWith('admin_update_ops_settings', {
      p_changes: { refund_delay_minutes: 12, float_alert_cents: 5_000 },
      p_reason: REASON,
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 70 })
    // Nothing on the site caches the limits.
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('refuses a wrong code before SQL sees the change', async () => {
    const session = owner({}, { error: { message: 'bad', code: 'mfa_verification_failed' } })
    const result = await updateLimits({
      changes: { refund_delay_minutes: 12 },
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(result.serverError).toBe(
      "That code didn't work. Check your authenticator app and try again.",
    )
    expect(wrapperCalls(session.rpc)).toEqual([])
  })

  it('refuses an operator in words, before any code or wrapper', async () => {
    const session = asRole('operator')
    const result = await updateLimits({
      changes: { refund_delay_minutes: 12 },
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(result.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(wrapperCalls(session.rpc)).toEqual([])
  })

  it('refuses a value outside the wrapper’s bounds, an unknown key and an empty change, unasked', async () => {
    const session = owner()
    for (const changes of [
      { auto_refund_max_kobo: 200_000_000 },
      { refund_delay_minutes: 0 },
      { refund_delay_minutes: 12.5 },
      { vat_pct: 5 },
      {},
    ]) {
      const result = await updateLimits({
        changes: changes as never,
        reason: REASON,
        requestKey: KEY,
        code: CODE,
      })
      expect(result.validationErrors, JSON.stringify(changes)).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it("says SQL's refusal in words, and a failure nobody explained as the crash words", async () => {
    owner({
      admin_update_ops_settings: [
        { data: { ok: false, code: 'OUT_OF_RANGE', auditId: 71 } },
        { error: { message: 'fetch failed' } },
      ],
    })
    const input = {
      changes: { velocity_new_max: 900 },
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    }
    expect((await updateLimits(input)).data).toEqual({
      ok: false,
      code: 'OUT_OF_RANGE',
      message: 'A value is outside what this setting allows.',
      auditId: 71,
    })
    expect((await updateLimits(input)).serverError).toBe(SERVER_CRASH_WORDS)
  })
})

describe('extension flags (extension.flags, money, owner)', () => {
  const ok = { admin_set_tld_flags: { data: { ok: true, auditId: 80 } } }

  it('pauses with its own reason, keeping the featuring, and expires the prices', async () => {
    const session = owner(ok)
    const result = await setExtensionFlags({
      name: '.Africa'.replace('.', ''),
      change: { kind: 'pause', why: 'Registry wants extra details now' },
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_set_tld_flags', {
      p_name: 'africa',
      p_is_paused: true,
      p_paused_reason: 'Registry wants extra details now',
      p_featured_rank: null,
      p_featured_tagline: null,
      p_reason: 'Registry wants extra details now',
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 80 })
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })

  it('resumes, leaving the featuring alone', async () => {
    const session = owner(ok)
    await setExtensionFlags({
      name: 'ng',
      change: { kind: 'resume', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_set_tld_flags',
      expect.objectContaining({
        p_is_paused: false,
        p_paused_reason: null,
        p_featured_rank: null,
        p_featured_tagline: null,
      }),
    )
  })

  it('features at a free rank, and stops featuring with rank 0 and an empty tagline', async () => {
    featured([{ name: 'com', featured_rank: 1 }])
    const session = owner(ok)
    await setExtensionFlags({
      name: 'africa',
      change: { kind: 'feature', rank: 4, tagline: 'For the continent', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_set_tld_flags',
      expect.objectContaining({
        p_is_paused: null,
        p_featured_rank: 4,
        p_featured_tagline: 'For the continent',
      }),
    )
    await setExtensionFlags({
      name: 'africa',
      change: { kind: 'unfeature', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_set_tld_flags',
      expect.objectContaining({ p_featured_rank: 0, p_featured_tagline: '' }),
    )
  })

  it('refuses a rank another extension holds before asking SQL, and nothing is expired', async () => {
    featured([
      { name: 'com', featured_rank: 1 },
      { name: 'africa', featured_rank: 4 },
    ])
    const session = owner(ok)
    const result = await setExtensionFlags({
      name: 'co',
      change: { kind: 'feature', rank: 1, tagline: '', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toEqual({
      ok: false,
      code: 'RANK_TAKEN',
      message: "Rank 1 is .com's. Choose another rank, or move .com first.",
    })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_set_tld_flags', expect.anything())
    expect(revalidateTag).not.toHaveBeenCalled()

    // Its own rank is not "taken".
    await setExtensionFlags({
      name: 'africa',
      change: { kind: 'feature', rank: 4, tagline: 'New words', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_set_tld_flags',
      expect.objectContaining({ p_name: 'africa', p_featured_rank: 4 }),
    )
  })

  it('reads a rank taken in between as the same refusal: the call rolled back', async () => {
    featured([])
    owner({
      admin_set_tld_flags: {
        error: { message: 'duplicate key value violates unique constraint', code: '23505' },
      },
    })
    const result = await setExtensionFlags({
      name: 'co',
      change: { kind: 'feature', rank: 2, tagline: '', reason: REASON },
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toMatchObject({ ok: false, code: 'RANK_TAKEN' })
  })

  it('expires nothing when SQL refuses, and says why', async () => {
    owner({ admin_set_tld_flags: { data: { ok: false, code: 'PAUSE_REASON', auditId: 81 } } })
    const result = await setExtensionFlags({
      name: 'ng',
      change: { kind: 'pause', why: 'Too short really' },
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toMatchObject({
      ok: false,
      message: 'Say why the extension is paused, in 3 to 120 characters.',
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('refuses a test administrator in words: an owner’s action', async () => {
    const session = asRole('operator', { testOnly: true, label: 'e2e-ops' })
    const result = await setExtensionFlags({
      name: 'ng',
      change: { kind: 'pause', why: 'e2e: checking the pause dialog' },
      requestKey: KEY,
      code: CODE,
    })
    expect(result.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(wrapperCalls(session.rpc)).toEqual([])
  })
})

describe('SSL products (ssl_product.sellable, money, owner)', () => {
  it('turns a product on and expires the prices', async () => {
    const session = owner({ admin_set_ssl_sellable: { data: { ok: true, auditId: 90 } } })
    const result = await setSslSellable({
      productCode: '382',
      sellable: true,
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_set_ssl_sellable', {
      p_product_code: '382',
      p_sellable: true,
      p_reason: REASON,
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 90 })
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })

  it('says a product with no price cannot go on sale, and expires nothing', async () => {
    owner({ admin_set_ssl_sellable: { data: { ok: false, code: 'NO_PRICE', auditId: 91 } } })
    const result = await setSslSellable({
      productCode: '382',
      sellable: true,
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toMatchObject({
      ok: false,
      message: 'DomainNameAPI lists no price for this product yet.',
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('preset drafts (D21)', () => {
  const draftInput = {
    presetId: PRESET,
    nameservers: ['NS1.Example-Host.test', 'ns2.example-host.test'],
    sourceUrl: 'https://docs.example-host.test/nameservers',
    assignsPerZone: false,
    reason: REASON,
    requestKey: KEY,
    code: CODE,
  }

  it('saves a draft of a preset (money, owner): lower-cased hosts, no notes as null', async () => {
    const session = owner({
      admin_save_preset_draft: {
        data: { ok: true, auditId: 100, after: { draft_id: DRAFT, nameservers: [] } },
      },
    })
    const result = await savePresetDraft(draftInput)
    expect(session.challengeAndVerify).toHaveBeenCalled()
    expect(session.rpc).toHaveBeenCalledWith('admin_save_preset_draft', {
      p_preset_id: PRESET,
      p_provider: null,
      p_nameservers: ['ns1.example-host.test', 'ns2.example-host.test'],
      p_source_url: 'https://docs.example-host.test/nameservers',
      p_notes: null,
      p_assigns_per_zone: false,
      p_reason: REASON,
      p_request_key: KEY,
    })
    expect(result.data).toMatchObject({ ok: true, after: { draft_id: DRAFT } })
    // A draft changes nothing customers see.
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('saves a new host by name, and a per-domain host with no nameservers', async () => {
    const session = owner({ admin_save_preset_draft: { data: { ok: true, auditId: 101 } } })
    await savePresetDraft({
      ...draftInput,
      presetId: null,
      provider: 'Example Host',
      nameservers: [],
      assignsPerZone: true,
      notes: 'Per their docs',
    })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_save_preset_draft',
      expect.objectContaining({
        p_preset_id: null,
        p_provider: 'Example Host',
        p_nameservers: [],
        p_notes: 'Per their docs',
        p_assigns_per_zone: true,
      }),
    )
  })

  it('refuses a draft the wrapper would refuse, before any code or SQL', async () => {
    const session = owner()
    for (const input of [
      { ...draftInput, nameservers: ['ns1.example-host.test'] },
      { ...draftInput, nameservers: ['ns1.example-host.test', 'ns1.example-host.test'] },
      { ...draftInput, assignsPerZone: true },
      { ...draftInput, presetId: null },
      { ...draftInput, sourceUrl: 'http://docs.example-host.test' },
    ]) {
      expect((await savePresetDraft(input)).validationErrors).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it("says SQL's source rule in words", async () => {
    owner({
      admin_save_preset_draft: { data: { ok: false, code: 'SOURCE_NOT_ALLOWED', auditId: 102 } },
    })
    expect((await savePresetDraft(draftInput)).data).toMatchObject({
      ok: false,
      message:
        "The source must be the provider's own documentation, on a site listed for it. New sites are added in the SQL editor.",
    })
  })

  it('publishes (money, owner) and expires the preset lists at once', async () => {
    const session = owner({ admin_publish_preset_draft: { data: { ok: true, auditId: 103 } } })
    const result = await publishPresetDraft({
      draftId: DRAFT,
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_publish_preset_draft', {
      p_draft_id: DRAFT,
      p_reason: REASON,
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 103 })
    expect(revalidateTag).toHaveBeenCalledWith('nameserver-presets', { expire: 0 })
  })

  it('expires nothing when a publish is refused for want of a check', async () => {
    owner({
      admin_publish_preset_draft: { data: { ok: false, code: 'NOT_CHECKED', auditId: 104 } },
    })
    const result = await publishPresetDraft({
      draftId: DRAFT,
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toMatchObject({
      ok: false,
      message: 'Check the draft in public DNS first; it must pass after it was saved.',
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('discards (owner, standard: no code), with an optional reason', async () => {
    const session = owner({ admin_discard_preset_draft: { data: { ok: true, auditId: 105 } } })
    await discardPresetDraft({ draftId: DRAFT, requestKey: KEY })
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(session.rpc).toHaveBeenCalledWith('admin_discard_preset_draft', {
      p_draft_id: DRAFT,
      p_reason: null,
      p_request_key: KEY,
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('hiding and showing a preset', () => {
  it('hides as an operator, with no code, and expires the preset lists', async () => {
    const session = asRole(
      'operator',
      {},
      { admin_set_preset_hidden: { data: { ok: true, auditId: 110 } } },
    )
    const result = await hidePreset({ presetId: PRESET, requestKey: KEY })
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(session.rpc).toHaveBeenCalledWith('admin_set_preset_hidden', {
      p_id: PRESET,
      p_hidden: true,
      p_reason: null,
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 110 })
    expect(revalidateTag).toHaveBeenCalledWith('nameserver-presets', { expire: 0 })
  })

  it('shows again as the owner only, with a code, and expires the preset lists', async () => {
    const operator = asRole('operator')
    expect(
      (await showPreset({ presetId: PRESET, reason: REASON, requestKey: KEY, code: CODE }))
        .serverError,
    ).toBe("Your admin role can't do this. Ask the owner.")
    expect(wrapperCalls(operator.rpc)).toEqual([])

    const session = owner({ admin_set_preset_hidden: { data: { ok: true, auditId: 111 } } })
    await showPreset({ presetId: PRESET, reason: REASON, requestKey: KEY, code: CODE })
    expect(session.challengeAndVerify).toHaveBeenCalled()
    expect(session.rpc).toHaveBeenCalledWith('admin_set_preset_hidden', {
      p_id: PRESET,
      p_hidden: false,
      p_reason: REASON,
      p_request_key: KEY,
    })
    expect(revalidateTag).toHaveBeenCalledWith('nameserver-presets', { expire: 0 })
  })

  it('expires nothing when the checker hid it: it shows again by itself', async () => {
    owner({
      admin_set_preset_hidden: { data: { ok: false, code: 'CHECKER_HID_IT', auditId: 112 } },
    })
    const result = await showPreset({
      presetId: PRESET,
      reason: REASON,
      requestKey: KEY,
      code: CODE,
    })
    expect(result.data).toMatchObject({ ok: false, code: 'CHECKER_HID_IT' })
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('checking a draft now (preset.draft_check, D22)', () => {
  const BASE = 'http://gateway.test/v1'

  it('writes a global note naming the draft, then asks the gateway with its id', async () => {
    const session = owner({ admin_note: { data: { ok: true, auditId: 120 } } })
    const seen: Request[] = []
    server.use(
      http.post(`${BASE}/admin/presets/drafts/:id/check`, ({ request }) => {
        seen.push(request)
        return HttpResponse.json({
          ok: true,
          data: {
            ok: true,
            hosts: [{ host: 'ns1.example-host.test', ok: true }],
            checkedAt: '2026-10-03T13:05:00Z',
          },
        })
      }),
    )
    const result = await checkPresetDraft({ draftId: DRAFT })
    expect(session.rpc).toHaveBeenCalledWith('admin_note', {
      p_action: 'preset.draft_check',
      p_side: 'global',
      p_target_type: 'preset_draft',
      p_target_id: DRAFT,
      p_detail: {},
    })
    expect(new URL(seen[0]?.url ?? '').pathname).toBe(`/v1/admin/presets/drafts/${DRAFT}/check`)
    expect(seen[0]?.headers.get('x-admin-audit-id')).toBe('120')
    expect(seen[0]?.headers.get('x-admin-label')).toBe('owner')
    expect(result.data).toMatchObject({ ok: true, auditId: 120, data: { ok: true } })
  })

  it('stops when SQL refuses the note: a test admin never reaches the gateway', async () => {
    owner({ admin_note: { data: { ok: false, code: 'TEST_ADMIN', auditId: 121 } } })
    const seen: Request[] = []
    server.use(
      http.post(`${BASE}/admin/presets/drafts/:id/check`, ({ request }) => {
        seen.push(request)
        return HttpResponse.json({ ok: true, data: {} })
      }),
    )
    const result = await checkPresetDraft({ draftId: DRAFT })
    expect(seen).toHaveLength(0)
    expect(result.data).toMatchObject({ ok: false, code: 'TEST_ADMIN' })
  })

  it("words the gateway's refusals: the note's reason, and its own", async () => {
    owner({ admin_note: { data: { ok: true, auditId: 122 } } })
    server.use(
      http.post(`${BASE}/admin/presets/drafts/:id/check`, () =>
        HttpResponse.json(
          { ok: false, code: 'ADMIN_NOTE_REFUSED', reason: 'EXPIRED', message: 'refused' },
          { status: 403 },
        ),
      ),
    )
    expect((await checkPresetDraft({ draftId: DRAFT })).data).toMatchObject({
      ok: false,
      code: 'EXPIRED',
      message: 'That took too long, so nothing was read. Try again.',
    })
    server.use(
      http.post(`${BASE}/admin/presets/drafts/:id/check`, () =>
        HttpResponse.json(
          { ok: false, code: 'TOO_SOON', message: 'This draft was checked in the last minute.' },
          { status: 429 },
        ),
      ),
    )
    expect((await checkPresetDraft({ draftId: DRAFT })).data).toMatchObject({
      ok: false,
      code: 'TOO_SOON',
    })
  })

  it('is refused to an operator before any note', async () => {
    const session = asRole('operator')
    const result = await checkPresetDraft({ draftId: DRAFT })
    expect(result.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(wrapperCalls(session.rpc)).toEqual([])
  })
})
