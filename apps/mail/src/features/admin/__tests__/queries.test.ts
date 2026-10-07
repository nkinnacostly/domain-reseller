import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { AdminRefusal } from '../lib/errors'
import {
  getAccount,
  getAccounts,
  getAudit,
  getBillingIncidents,
  getDomains,
  getOverview,
  getReviewQueue,
  getSesHealth,
} from '../queries/mail'
import {
  adminSessionStatus,
  adminWhoami,
  assertAdminArea,
  findAdmin,
  requireAdmin,
} from '../queries/session'
import { ACCOUNT, fakeAdmin, navigation, whoami } from './fake-admin'

/**
 * Who Mail's admin is, and what it reads (MAIL-SPEC §10, M5): SQL answers
 * both — admin_whoami, admin_status and the admin_mail_* reads — through the
 * session client on schema public. A refusal or a failure is a value a page
 * can word (S11); an answer of an unknown shape is never shown.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

function use(options: Parameters<typeof fakeAdmin>[0] = {}) {
  const fake = fakeAdmin(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('who the admin is (ADR-006)', () => {
  it('asks admin_whoami on public, with the freshness a money action needs', async () => {
    const fake = use({ rpc: { admin_whoami: () => ({ data: whoami(), error: null }) } })
    const admin = await adminWhoami(fake.client as never, 5)
    expect(admin).toMatchObject({ label: 'owner', role: 'owner', testOnly: false })
    expect(Object.isFrozen(admin)).toBe(true)
    expect(fake.calls).toEqual([
      { schema: 'public', fn: 'admin_whoami', args: { p_fresh_minutes: 5 } },
    ])
    await adminWhoami(fake.client as never, null)
    expect(fake.calls[1]?.args).toEqual({})
  })

  it('refuses in words, and refuses an answer of a shape it does not know', async () => {
    const fake = use({
      rpc: { admin_whoami: () => ({ data: null, error: { message: 'admin:needs_code' } }) },
    })
    const refused = await adminWhoami(fake.client as never, null).catch((error) => error)
    expect(refused).toBeInstanceOf(AdminRefusal)
    expect(refused.adminCode).toBe('needs_code')
    const odd = use({ rpc: { admin_whoami: () => ({ data: { userId: 'x' }, error: null }) } })
    const strange = await adminWhoami(odd.client as never, null).catch((error) => error)
    expect(strange.adminCode).toBe('not_admin')
  })

  it('makes a stranger, someone signed out or a refused session a 404, and an old code a trip to /verify', async () => {
    use({ user: null })
    expect(await navigation(requireAdmin())).toBe('NOT_FOUND')
    use({ rpc: { admin_whoami: () => ({ data: null, error: { message: 'admin:not_admin' } }) } })
    expect(await navigation(requireAdmin())).toBe('NOT_FOUND')
    use({ rpc: { admin_whoami: () => ({ data: null, error: { message: 'admin:needs_code' } }) } })
    expect(await navigation(requireAdmin())).toBe('/verify?next=/admin')
    use({ rpc: { admin_whoami: () => ({ data: whoami({ role: 'viewer' }), error: null }) } })
    expect((await requireAdmin()).role).toBe('viewer')
  })

  it('finds the admin for the sidebar, or nobody, never throwing', async () => {
    use({ user: null })
    expect(await findAdmin()).toBeNull()
    use({ rpc: { admin_whoami: () => ({ data: null, error: { message: 'admin:weak_sign_in' } }) } })
    expect(await findAdmin()).toBeNull()
    use({ rpc: { admin_whoami: () => ({ data: whoami(), error: null }) } })
    expect((await findAdmin())?.label).toBe('owner')
  })

  it('reads the gate’s word, and turns a stranger away before any admin chrome', async () => {
    use({ user: null })
    expect(await adminSessionStatus()).toBe('not_admin')
    expect(await navigation(assertAdminArea())).toBe('NOT_FOUND')
    use({ rpc: { admin_status: () => ({ data: null, error: { code: '42883' } }) } })
    expect(await adminSessionStatus()).toBe('not_admin')
    use({ rpc: { admin_status: () => ({ data: 'factor_mismatch', error: null }) } })
    expect(await assertAdminArea()).toBe('factor_mismatch')
  })
})

const overview = {
  testOnly: false,
  accounts: { sandbox: 3, active: 5, paused: 1, closed: 0, sesPaused: 0 },
  reviewReady: 2,
  findings: { pause: 1, warning: 2 },
  pendingTenantActions: 1,
}

describe('the admin reads (D4)', () => {
  it('reads each admin_mail_* function on public with its filters', async () => {
    const fake = use({
      rpc: {
        admin_mail_overview: () => ({ data: overview, error: null }),
        admin_mail_review_queue: () => ({ data: [], error: null }),
        admin_mail_accounts: () => ({ data: { rows: [], total: 0 }, error: null }),
        admin_mail_account: () => ({ data: null, error: null }),
        admin_mail_domains: () => ({ data: { rows: [], total: 0 }, error: null }),
        admin_mail_audit: () => ({ data: { rows: [], total: 0 }, error: null }),
      },
    })
    expect(await getOverview()).toEqual({ ok: true, data: overview })
    expect(await getReviewQueue()).toEqual({ ok: true, data: [] })
    expect(await getAccounts({ state: 'paused', query: 'mdm-0123456789', page: 3 })).toEqual({
      ok: true,
      data: { rows: [], total: 0 },
    })
    expect(await getAccount(ACCOUNT)).toEqual({ ok: true, data: null })
    await getDomains({ status: 'failed', query: null, page: 1 })
    await getAudit({ action: 'mail.resume', page: 2 })
    expect(fake.calls.every((call) => call.schema === 'public')).toBe(true)
    expect(fake.calls.find((call) => call.fn === 'admin_mail_accounts')?.args).toEqual({
      p_state: 'paused',
      p_query: 'mdm-0123456789',
      p_offset: 100,
      p_limit: 50,
    })
    expect(fake.calls.find((call) => call.fn === 'admin_mail_audit')?.args).toEqual({
      p_action: 'mail.resume',
      p_offset: 50,
      p_limit: 50,
    })
  })

  it('answers a refusal by its code, a failure as read_failed, an odd answer as unexpected', async () => {
    use({
      rpc: {
        admin_mail_ses_health: () => ({ data: null, error: { message: 'admin:test_admin' } }),
      },
    })
    expect(await getSesHealth()).toEqual({ ok: false, code: 'test_admin' })
    use({
      rpc: {
        admin_mail_overview: () => ({
          data: null,
          error: { message: 'canceling statement', code: '57014' },
        }),
      },
    })
    expect(await getOverview()).toEqual({ ok: false, code: 'read_failed' })
    use({
      rpc: { admin_mail_overview: () => ({ data: { ...overview, reviewReady: -1 }, error: null }) },
    })
    expect(await getOverview()).toEqual({ ok: false, code: 'unexpected_answer' })
  })

  it('reads the billing incidents, open by default, with their accounts (migration 54)', async () => {
    const incident = {
      id: 7,
      createdAt: '2026-10-06T12:00:00Z',
      testMode: false,
      kind: 'unapplied_charge',
      accountId: ACCOUNT,
      tenant: 'mdm-0123456789',
      accountName: 'Acme',
      providerReference: '9100001',
      detail: { reason: 'underpaid', amount_kobo: 100 },
      resolvedAt: null,
      resolvedBy: null,
    }
    const fake = use({
      rpc: {
        admin_mail_billing_incidents: () => ({
          data: { rows: [incident], total: 1, open: 1 },
          error: null,
        }),
      },
    })
    expect(await getBillingIncidents({ show: 'open', page: 1 })).toEqual({
      ok: true,
      data: { rows: [incident], total: 1, open: 1 },
    })
    await getBillingIncidents({ show: 'resolved', page: 2 })
    await getBillingIncidents({ show: 'all', page: 1 })
    expect(fake.calls.map((call) => call.args)).toEqual([
      { p_open: true, p_offset: 0, p_limit: 50 },
      { p_open: false, p_offset: 50, p_limit: 50 },
      { p_open: null, p_offset: 0, p_limit: 50 },
    ])
    expect(fake.calls.every((call) => call.schema === 'public')).toBe(true)
  })

  it('reads the SES health whole, and a quota heartbeat with odd numbers as unknown', async () => {
    const health = {
      quota: {
        readAt: '2026-10-06T12:00:00Z',
        max24HourSend: 50000,
        sentLast24Hours: 'many',
        maxSendRate: 14,
        share: 0.2,
        holdFree: false,
      },
      quotaAlertPct: 80,
      budget: { dailyBudget: 49000, reserved24h: 12 },
      reputation: {
        latest: null,
        lastReadAt: null,
        lastOutcome: null,
        recent: [],
        bounceWarnPpm: 20000,
        complaintWarnPpm: 500,
        bouncePausePpm: 40000,
        complaintPausePpm: 800,
      },
      heartbeats: [{ name: 'mail-worker:send', beatAt: '2026-10-06T12:00:00Z', silent: false }],
      events: { lastReceivedAt: null, sentLastHour: 0 },
      pendingTenantActions: 0,
    }
    use({ rpc: { admin_mail_ses_health: () => ({ data: health, error: null }) } })
    const read = await getSesHealth()
    expect(read.ok && read.data.quota?.sentLast24Hours).toBeNull()
    expect(read.ok && read.data.quota?.maxSendRate).toBe(14)
  })
})
