import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requeueEmail } from '@/features/admin/actions/emails'
import { adminOutcome, SERVER_CRASH_WORDS, UNKNOWN_OUTCOME } from '@/features/admin/lib/errors'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { ids } from './fake-db'

/**
 * "Send again" (ADMIN-SPEC §3.1.2, §5.2 B11), refusals first: input that
 * does not validate reaches no session, a viewer is refused before SQL, and
 * the wrapper's refusals come back in words. Only admin_requeue_email is
 * called, with the session client, and nothing about the email is logged.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const KEY = '9a9b9c9d-0e0f-4a1b-8c2d-3e3f4a4b5c5d'

type Rpc = Record<string, { data?: unknown; error?: { message: string } | null }>

function use(rpc: Rpc = {}, role = 'operator', testOnly = false) {
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role, testOnly, label: 'ops' }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const calls = (session: ReturnType<typeof sessionClient>) =>
  session.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined as never)
  }
})

describe('requeueEmail: refusals first', () => {
  it('validates before anything: a bad id, a bad key or a long reason reaches no session', async () => {
    const session = use()
    for (const input of [
      { emailId: 'not-a-uuid', requestKey: KEY },
      { emailId: ids.email, requestKey: 'nope' },
      { emailId: ids.email, requestKey: KEY, reason: 'x'.repeat(501) },
    ]) {
      const answer = await requeueEmail(input)
      expect(answer.validationErrors, JSON.stringify(input)).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('refuses a viewer before SQL is asked', async () => {
    const session = use({ admin_requeue_email: { data: { ok: true, auditId: 1 } } }, 'viewer')
    const answer = await requeueEmail({ emailId: ids.email, requestKey: KEY })
    expect(answer.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(calls(session)).toEqual([])
  })

  it('words every refusal the wrapper records, with its audit row', async () => {
    const words: Record<string, string> = {
      BOUNCED: 'This email bounced. It is not sent again.',
      COMPLAINED: 'The recipient reported this email as spam. It is not sent again.',
      NOT_FAILED: 'Only a failed email can be sent again.',
      TEST_ADMIN: "Test administrators can't do this on live records.",
      NOT_FOUND: 'That record no longer exists. Reload the page.',
    }
    for (const [code, message] of Object.entries(words)) {
      use({ admin_requeue_email: { data: { ok: false, auditId: 7, code } } })
      const answer = await requeueEmail({ emailId: ids.email, requestKey: KEY })
      expect(answer.data, code).toEqual({ ok: false, code, message, auditId: 7 })
    }
  })

  it('words a gate raise, and keeps an error it does not know from the page (N10)', async () => {
    use({ admin_requeue_email: { error: { message: 'admin:needs_code' } } })
    const refused = await requeueEmail({ emailId: ids.email, requestKey: KEY })
    expect(refused.serverError).toBe(
      "Confirm it's you with the code from your authenticator app to continue.",
    )

    use({ admin_requeue_email: { error: { message: 'canceling statement due to timeout' } } })
    const lost = await requeueEmail({ emailId: ids.email, requestKey: KEY })
    expect(lost.serverError).toBe(SERVER_CRASH_WORDS)
    // A lost answer may have committed: the dialog keeps its key and replays.
    expect(adminOutcome(lost)).toMatchObject({ ok: false, code: UNKNOWN_OUTCOME })
  })
})

describe('requeueEmail', () => {
  it('asks the wrapper once, with the session client, and answers its audit row', async () => {
    const session = use({
      admin_requeue_email: {
        data: { ok: true, auditId: 42, after: { status: 'pending' } },
      },
    })
    const answer = await requeueEmail({
      emailId: ids.email,
      requestKey: KEY,
      reason: '  The provider was down this morning.  ',
    })
    expect(answer.data).toEqual({ ok: true, auditId: 42, after: { status: 'pending' } })
    expect(calls(session)).toEqual([
      [
        'admin_requeue_email',
        {
          p_email_id: ids.email,
          p_reason: 'The provider was down this morning.',
          p_request_key: KEY,
        },
      ],
    ])
  })

  it('sends no reason as an empty one, which SQL stores as none', async () => {
    const session = use({ admin_requeue_email: { data: { ok: true, auditId: 43 } } })
    await requeueEmail({ emailId: ids.email, requestKey: KEY, reason: '   ' })
    expect(calls(session)[0]?.[1]).toEqual({
      p_email_id: ids.email,
      p_reason: '',
      p_request_key: KEY,
    })
  })

  it('lets a test admin ask: SQL holds it to an e2e account’s test email (D15)', async () => {
    const session = use(
      { admin_requeue_email: { data: { ok: true, auditId: 44 } } },
      'operator',
      true,
    )
    const answer = await requeueEmail({ emailId: ids.email, requestKey: KEY })
    expect(answer.data).toMatchObject({ ok: true, auditId: 44 })
    expect(calls(session)).toHaveLength(1)
  })

  it('replays a repeated key as done, and logs nothing about the email (N13)', async () => {
    use({ admin_requeue_email: { data: { ok: true, auditId: 45, replayed: true } } })
    const answer = await requeueEmail({ emailId: ids.email, requestKey: KEY })
    expect(answer.data).toEqual({ ok: true, auditId: 45, replayed: true })
    const logged = JSON.stringify(
      (['info', 'warn', 'error', 'debug'] as const).flatMap(
        (level) => vi.mocked(logger[level]).mock.calls,
      ),
    )
    expect(logged).not.toContain(ids.email)
    expect(logged).not.toContain('@')
  })
})
