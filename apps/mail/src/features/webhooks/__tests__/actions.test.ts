import { openWebhookSecret } from '@dr/shared/webhooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { ACCOUNT, fakeSupabase } from '../../accounts/__tests__/fake-supabase'

/**
 * The Webhooks page's actions (MAIL-SPEC §6, §10, MR6; migration 49): who may
 * call them, what reaches SQL — never a plain secret — and every answer in
 * words.
 */

const KEY = new Uint8Array(32).map((_, i) => 255 - i)
process.env.MAIL_WEBHOOK_SECRET_KEY = Buffer.from(KEY).toString('base64')

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const { env } = await import('@/lib/env')
const {
  createWebhook,
  deleteWebhook,
  resendDelivery,
  rotateWebhookSecret,
  setWebhookEnabled,
  updateWebhook,
} = await import('../actions/webhooks')
const { NO_SEAL_KEY } = await import('../lib/seal-key')

const WEBHOOK = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const settings = env as { MAIL_WEBHOOK_SECRET_KEY?: string }
const ok =
  (extra: Record<string, unknown> = {}) =>
  () => ({ data: { ok: true, ...extra }, error: null })
const refuse =
  (code: string, extra: Record<string, unknown> = {}) =>
  () => ({ data: { ok: false, code, ...extra }, error: null })

function use(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const input = {
  accountId: ACCOUNT,
  url: ' https://Hooks.Acme.example/mail#top ',
  events: ['email.delivered', 'email.bounced', 'email.delivered'] as const,
  description: '  Production  ',
}

beforeEach(() => {
  vi.clearAllMocks()
  settings.MAIL_WEBHOOK_SECRET_KEY = Buffer.from(KEY).toString('base64')
})

describe('createWebhook', () => {
  it('seals a new secret for the account, sends only the sealed form, and answers the secret once', async () => {
    const fake = use({ role: 'developer', rpc: { create_webhook: ok({ webhookId: WEBHOOK }) } })
    const result = await createWebhook({ ...input, events: [...input.events] })
    const secret = (result.data as { secret: string }).secret
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32}$/)
    const args = fake.rpcCalls[0]?.args as Record<string, unknown>
    expect(args).toMatchObject({
      p_account_id: ACCOUNT,
      p_url: 'https://hooks.acme.example/mail',
      p_events: ['email.delivered', 'email.bounced'],
      p_description: 'Production',
      p_secret_hint: `whsec_${secret.slice(6, 10)}`,
    })
    expect(JSON.stringify(args)).not.toContain(secret.slice(6))
    expect(await openWebhookSecret(KEY, String(args.p_secret_sealed), ACCOUNT)).toBe(secret)
    expect(result.data).toEqual({ secret, webhookId: WEBHOOK })
  })

  it('checks the address and the events before anything is sealed or saved', async () => {
    const fake = use({ role: 'owner' })
    const http = await createWebhook({
      ...input,
      url: 'http://hooks.acme.example/x',
      events: ['email.sent'],
    })
    expect(http.validationErrors).toMatchObject({
      url: { _errors: [expect.stringContaining('https')] },
    })
    const local = await createWebhook({
      ...input,
      url: 'https://10.0.0.1/x',
      events: ['email.sent'],
    })
    expect(local.validationErrors).toMatchObject({
      url: { _errors: [expect.stringContaining('private')] },
    })
    const port = await createWebhook({
      ...input,
      url: 'https://hooks.acme.example:8080/x',
      events: ['email.sent'],
    })
    expect(port.validationErrors).toMatchObject({
      url: { _errors: [expect.stringContaining('443')] },
    })
    const none = await createWebhook({ ...input, events: [] })
    expect(none.validationErrors).toMatchObject({
      events: { _errors: ['Choose at least one event.'] },
    })
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('is not for viewers', async () => {
    const fake = use({ role: 'viewer' })
    const result = await createWebhook({ ...input, events: ['email.sent'] })
    expect(result.serverError).toMatch(/role/)
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('makes nothing without the sealing key — never a plain secret', async () => {
    settings.MAIL_WEBHOOK_SECRET_KEY = undefined
    const fake = use({ role: 'owner' })
    expect((await createWebhook({ ...input, events: ['email.sent'] })).data).toEqual({
      error: NO_SEAL_KEY,
    })
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('words SQL’s refusals, and fails loudly when SQL cannot be asked', async () => {
    use({ role: 'owner', rpc: { create_webhook: refuse('webhook_limit', { max: 10 }) } })
    expect((await createWebhook({ ...input, events: ['email.sent'] })).data).toEqual({
      error: expect.stringContaining('10 endpoints'),
    })
    use({
      role: 'owner',
      rpc: { create_webhook: () => ({ data: null, error: { code: '08006' } }) },
    })
    expect((await createWebhook({ ...input, events: ['email.sent'] })).serverError).toBeTruthy()
  })
})

describe('changing an endpoint', () => {
  it('updateWebhook sends the checked address and events; a blank description clears it', async () => {
    const fake = use({ role: 'admin', rpc: { update_webhook: ok() } })
    expect(
      (
        await updateWebhook({
          ...input,
          webhookId: WEBHOOK,
          events: ['email.failed'],
          description: ' ',
        })
      ).data,
    ).toEqual({ ok: true })
    expect(fake.rpcCalls[0]).toEqual({
      fn: 'update_webhook',
      args: {
        p_account_id: ACCOUNT,
        p_webhook_id: WEBHOOK,
        p_url: 'https://hooks.acme.example/mail',
        p_events: ['email.failed'],
      },
    })
    use({ role: 'admin', rpc: { update_webhook: refuse('validation', { field: 'url' }) } })
    expect(
      (await updateWebhook({ ...input, webhookId: WEBHOOK, events: ['email.failed'] })).data,
    ).toEqual({ error: expect.stringContaining('public host name') })
  })

  it('setWebhookEnabled turns it off and on', async () => {
    const fake = use({ role: 'developer', rpc: { set_webhook_enabled: ok() } })
    await setWebhookEnabled({ accountId: ACCOUNT, webhookId: WEBHOOK, enabled: false })
    expect(fake.rpcCalls[0]?.args).toEqual({
      p_account_id: ACCOUNT,
      p_webhook_id: WEBHOOK,
      p_enabled: false,
    })
    use({ role: 'developer', rpc: { set_webhook_enabled: refuse('account_closed') } })
    expect(
      (await setWebhookEnabled({ accountId: ACCOUNT, webhookId: WEBHOOK, enabled: true })).data,
    ).toEqual({ error: expect.stringContaining('closed') })
  })

  it('rotateWebhookSecret seals a fresh secret and answers it once', async () => {
    const fake = use({ role: 'owner', rpc: { rotate_webhook_secret: ok() } })
    const result = await rotateWebhookSecret({ accountId: ACCOUNT, webhookId: WEBHOOK })
    const secret = (result.data as { secret: string }).secret
    const args = fake.rpcCalls[0]?.args as Record<string, string>
    // The secret is sealed for the account SQL is told the endpoint belongs to (migration 54).
    expect(args.p_account_id).toBe(ACCOUNT)
    expect(await openWebhookSecret(KEY, args.p_secret_sealed ?? '', args.p_account_id ?? '')).toBe(
      secret,
    )
    use({ role: 'owner', rpc: { rotate_webhook_secret: refuse('not_found') } })
    expect((await rotateWebhookSecret({ accountId: ACCOUNT, webhookId: WEBHOOK })).data).toEqual({
      error: expect.stringContaining('not found'),
    })
    settings.MAIL_WEBHOOK_SECRET_KEY = 'not a key'
    expect((await rotateWebhookSecret({ accountId: ACCOUNT, webhookId: WEBHOOK })).data).toEqual({
      error: NO_SEAL_KEY,
    })
  })

  it('deleteWebhook and resendDelivery pass their ids and word their refusals', async () => {
    const fake = use({
      role: 'owner',
      rpc: { delete_webhook: ok(), resend_webhook_delivery: ok() },
    })
    expect((await deleteWebhook({ accountId: ACCOUNT, webhookId: WEBHOOK })).data).toEqual({
      ok: true,
    })
    expect((await resendDelivery({ accountId: ACCOUNT, deliveryId: 41 })).data).toEqual({
      ok: true,
    })
    expect(fake.rpcCalls.map((call) => call.args)).toEqual([
      { p_account_id: ACCOUNT, p_webhook_id: WEBHOOK },
      { p_account_id: ACCOUNT, p_delivery_id: 41 },
    ])
    use({
      role: 'owner',
      rpc: { resend_webhook_delivery: refuse('in_progress'), delete_webhook: refuse('forbidden') },
    })
    expect((await resendDelivery({ accountId: ACCOUNT, deliveryId: 41 })).data).toEqual({
      error: expect.stringContaining('still being tried'),
    })
    expect((await deleteWebhook({ accountId: ACCOUNT, webhookId: WEBHOOK })).data).toEqual({
      error: expect.stringContaining('cannot manage webhooks'),
    })
  })

  it.each([
    [
      'update_webhook',
      () => updateWebhook({ ...input, webhookId: WEBHOOK, events: ['email.sent'] }),
    ],
    [
      'set_webhook_enabled',
      () => setWebhookEnabled({ accountId: ACCOUNT, webhookId: WEBHOOK, enabled: true }),
    ],
    [
      'rotate_webhook_secret',
      () => rotateWebhookSecret({ accountId: ACCOUNT, webhookId: WEBHOOK }),
    ],
    ['delete_webhook', () => deleteWebhook({ accountId: ACCOUNT, webhookId: WEBHOOK })],
    ['resend_webhook_delivery', () => resendDelivery({ accountId: ACCOUNT, deliveryId: 1 })],
  ])('%s fails loudly when SQL cannot be asked', async (fn, run) => {
    use({ role: 'owner', rpc: { [fn]: () => ({ data: null, error: { code: '08006' } }) } })
    expect((await run()).serverError).toBeTruthy()
  })
})
