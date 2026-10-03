import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failJob, failSslJob, retryJob, retrySslJob } from '@/features/admin/actions/jobs'
import {
  ADMIN_ERROR_WORDS,
  NEEDS_CODE_WORDS,
  SERVER_CRASH_WORDS,
  WRONG_CODE_WORDS,
} from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const JOB = '3c9e6b1a-1d2f-4e5a-8b7c-6d5e4f3a2b1c'
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'
const input = {
  jobId: JOB,
  reason: 'read the registry: it is free',
  requestKey: KEY,
  code: '123456',
}

function use(session: ReturnType<typeof sessionClient>) {
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('the queue actions (ADMIN-SPEC §5.2 B4): money tier, one wrapper each', () => {
  it.each([
    ['retryJob', retryJob, 'admin_retry_job'],
    ['failJob', failJob, 'admin_fail_job'],
    ['retrySslJob', retrySslJob, 'admin_retry_ssl_job'],
    ['failSslJob', failSslJob, 'admin_fail_ssl_job'],
  ] as const)(
    '%s verifies the code with this session’s factor, then calls %s',
    async (_, action, wrapper) => {
      const session = use(
        sessionClient({
          rpc: {
            admin_whoami: { data: whoami({ role: 'operator', label: 'ops' }) },
            [wrapper]: { data: { ok: true, auditId: 42 } },
          },
        }),
      )
      const result = await action({ ...input, jobId: JOB.toUpperCase() })

      expect(result.data).toEqual({ ok: true, auditId: 42 })
      expect(session.challengeAndVerify).toHaveBeenCalledWith({
        factorId: whoami().factorId,
        code: '123456',
      })
      expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
      expect(session.rpc).toHaveBeenLastCalledWith(wrapper, {
        p_job_id: JOB,
        p_reason: 'read the registry: it is free',
        p_request_key: KEY,
      })
    },
  )

  it('validates first: a bad id, a short reason or no code reaches nothing', async () => {
    const session = use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    for (const bad of [
      { ...input, jobId: 'example.com' },
      { ...input, reason: 'short' },
      { ...input, code: '12345' },
      { ...input, requestKey: 'not-a-key' },
    ]) {
      const result = await retryJob(bad)
      expect(result.validationErrors).toBeDefined()
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('refuses a wrong code before any wrapper is called', async () => {
    const session = use(
      sessionClient({
        rpc: { admin_whoami: { data: whoami() } },
        verify: { error: { message: 'Invalid TOTP code', code: 'mfa_verification_failed' } },
      }),
    )
    expect(await failJob(input)).toEqual({ serverError: WRONG_CODE_WORDS })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_fail_job', expect.anything())
  })

  it('refuses a viewer in words before the code is checked', async () => {
    const session = use(
      sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'viewer' }) } } }),
    )
    expect(await retryJob(input)).toEqual({
      serverError: "Your admin role can't do this. Ask the owner.",
    })
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
  })

  it('answers a refusal from the wrapper in words, keeping its audit id', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami() },
          admin_fail_job: {
            data: { ok: false, code: 'READ_REGISTRY_FIRST', auditId: 7 },
          },
        },
      }),
    )
    expect((await failJob(input)).data).toEqual({
      ok: false,
      code: 'READ_REGISTRY_FIRST',
      message: ADMIN_ERROR_WORDS.READ_REGISTRY_FIRST,
      auditId: 7,
    })
  })

  it('words a gate refusal, and hides an error nobody wrote words for', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: [{ data: whoami() }, { error: { message: 'admin:needs_code' } }],
        },
      }),
    )
    expect(await retryJob(input)).toEqual({ serverError: NEEDS_CODE_WORDS })

    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami() },
          admin_retry_job: { error: { message: 'canceling statement due to statement timeout' } },
        },
      }),
    )
    const lost = await retryJob(input)
    expect(lost).toEqual({ serverError: SERVER_CRASH_WORDS })
    expect(JSON.stringify(lost)).not.toContain('statement')

    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami() },
          admin_retry_ssl_job: { error: { message: 'admin:test_admin' } },
        },
      }),
    )
    expect(await retrySslJob(input)).toEqual({ serverError: ADMIN_ERROR_WORDS.test_admin })
  })
})
