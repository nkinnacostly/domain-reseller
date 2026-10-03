import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { server } from '../../../../../tests/mocks/server'

/**
 * D6 and D8 against the hosted project, end to end: what adminMoneyAction
 * does — challengeAndVerify on a session that already has its code — must
 * refresh the totp time in the session's `amr`, or admin_whoami(5) and every
 * money wrapper would refuse a code typed seconds ago. Opt-in:
 *
 *   DB_TESTS=1 pnpm --filter @dr/web exec vitest run src/features/admin/__tests__/foundation/step-up.db.test.ts
 *
 * The step-up itself needs only Supabase Auth. The money half needs
 * migrations 40–41 and skips, visibly, until they are applied: it approves a
 * test refund held by hold_test_refund as a test admin, through the real
 * wrapper (BACKLOG A8). It makes its own e2e-* user and removes it.
 */

const ROOT_ENV = join(__dirname, '../../../../../../../.env')
const KEYS =
  /^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|SUPABASE_SECRET_KEY)=(.*)$/

const PASSWORD = 'e2e-Correct-Horse-9'

/** RFC 6238 for a base32 secret, as tests/e2e/support/accounts.mjs does (that module needs file URLs). */
function totpCode(secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/\s|=/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 15
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** The newest totp time in an access token's `amr`, in epoch seconds. */
function totpAt(accessToken: string): number {
  const payload = JSON.parse(
    Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { amr?: { method: string; timestamp: number }[] }
  return Math.max(...(payload.amr ?? []).filter((e) => e.method === 'totp').map((e) => e.timestamp))
}

/** Waits for the next 30-second window: a code is not accepted twice. */
async function nextWindow() {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30)
  await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000))
}

describe.skipIf(process.env.DB_TESTS !== '1')(
  'a step-up on the hosted project (D6, D8)',
  { timeout: 120_000 },
  () => {
    let service: SupabaseClient
    let session: SupabaseClient
    let user: { id: string; email: string } | undefined
    let factorId = ''
    let secret = ''
    let first = 0
    let stepped = 0

    beforeAll(async () => {
      server.close()
      for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
        const match = KEYS.exec(line.trim())
        if (match?.[1] && match[2]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
      }
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
      service = createClient(url, process.env.SUPABASE_SECRET_KEY ?? '', {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      session = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '', {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const email = `e2e-stepup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
      const created = await service.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      })
      if (created.error) throw created.error
      user = { id: created.data.user.id, email }
      const signedIn = await session.auth.signInWithPassword({ email, password: PASSWORD })
      if (signedIn.error) throw signedIn.error
      const enrolled = await session.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Step-up',
      })
      if (enrolled.error) throw enrolled.error
      factorId = enrolled.data.id
      secret = enrolled.data.totp.secret
      // Enrolling verifies the first code and makes the session aal2.
      const verified = await session.auth.mfa.challengeAndVerify({
        factorId,
        code: totpCode(secret),
      })
      if (verified.error) throw verified.error
      first = totpAt(verified.data.access_token)
    }, 120_000)

    afterAll(async () => {
      if (user) {
        await service.from('domains').delete().eq('user_id', user.id)
        await service.rpc('purge_test_orders', { p_user_id: user.id })
        await service.auth.admin.deleteUser(user.id)
      }
      server.listen({ onUnhandledRequest: 'error' })
    }, 60_000)

    it("refreshes the session's totp time when an aal2 session verifies a new code", async () => {
      await nextWindow()
      const again = await session.auth.mfa.challengeAndVerify({
        factorId,
        code: totpCode(secret),
      })
      expect(again.error).toBeNull()
      stepped = totpAt(again.data?.access_token ?? '')
      expect(first).toBeGreaterThan(0)
      expect(stepped).toBeGreaterThan(first)
      expect(Math.abs(Date.now() / 1000 - stepped)).toBeLessThan(60)
    })

    it('lets the stepped-up session approve a held test refund through the money wrapper', async (context) => {
      const schema = await service.from('admin_audit_log').select('id').limit(1)
      if (schema.error) {
        context.skip('migrations 40–41 are not on this database yet (BACKLOG A8)')
      }
      if (!user || stepped === 0) throw new Error('the step-up did not run')
      const granted = await service.rpc('grant_test_admin', { p_user_id: user.id })
      expect(granted.error).toBeNull()

      // A paid test order whose one line failed: the refund is queued, then held.
      const { data: rate } = await service.from('fx_rates').select('id').limit(1).single()
      const stamp = Date.now().toString(36)
      const { data: order, error } = await service
        .from('orders')
        .insert({
          user_id: user.id,
          subtotal_kobo: 100_000,
          vat_pct: 7.5,
          vat_kobo: 7_500,
          total_kobo: 107_500,
          fx_rate_id: rate?.id,
          tx_ref: `MDH-e2e-stepup-${stamp}`,
          registrant: {},
          float_check: 'covered',
          test_mode: true,
        })
        .select('id')
        .single()
      if (error) throw error
      await service.from('order_items').insert({
        order_id: order.id,
        domain: `e2estepup${stamp}.com`,
        tld: 'com',
        period_years: 1,
        privacy: false,
        auto_renew: false,
        price_kobo: 100_000,
        renewal_kobo: 100_000,
      })
      const paid = await service.rpc('record_order_payment', {
        p_order_id: order.id,
        p_provider_reference: `stepup-${stamp}`,
        p_amount_kobo: 107_500,
        p_currency: 'NGN',
        p_method: 'card',
        p_raw: { id: `stepup-${stamp}`, status: 'successful' },
      })
      expect(paid.error).toBeNull()
      const { data: jobs } = await service
        .from('jobs')
        .select('id, order_items!inner(order_id)')
        .eq('order_items.order_id', order.id)
      for (const job of jobs ?? []) {
        await service.rpc('claim_job', {
          p_worker: 'db-test',
          p_test_mode: true,
          p_lease_seconds: 300,
          p_job_id: job.id,
        })
        await service.rpc('fail_job', {
          p_job_id: job.id,
          p_code: 'DOMAIN_TAKEN',
          p_message: 'Domain exists',
          p_needs_attention: false,
        })
      }
      const { data: refund } = await service
        .from('refunds')
        .select('id')
        .eq('order_id', order.id)
        .single()
      const held = await service.rpc('hold_test_refund', { p_refund_id: refund?.id })
      expect(held.error).toBeNull()

      // What adminMoneyAction runs after the step-up: whoami(5), then the wrapper.
      const whoami = await session.rpc('admin_whoami', { p_fresh_minutes: 5 })
      expect(whoami.error).toBeNull()
      expect(Math.round(new Date(whoami.data.codeAt).getTime() / 1000)).toBe(stepped)
      const approved = await session.rpc('admin_approve_refund', {
        p_refund_id: refund?.id,
        p_reason: 'db test: a stepped-up session approves',
        p_request_key: crypto.randomUUID(),
      })
      expect(approved.error).toBeNull()
      expect(approved.data).toMatchObject({ ok: true })
      const { data: after } = await service
        .from('refunds')
        .select('status, approved_by')
        .eq('id', refund?.id)
        .single()
      expect(after).toEqual({ status: 'queued', approved_by: granted.data })
    })
  },
)
