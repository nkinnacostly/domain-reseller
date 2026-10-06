import { describe, expect, it, vi } from 'vitest'
import { mockRpc } from '../../../../tests/mocks/supabase'
import { TOKEN } from './fake-sql'

/**
 * Before the manager key is on the deployment, the job route still answers
 * cleanly (pg_cron calls it every five minutes from the moment migration 47
 * is applied), and the domains page's SES work is left for later — never a
 * crash, never a guess.
 */

vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = ''
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = ''
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = ''
})

const { handleSesJobs } = await import('../api/jobs-route')
const { SesNotConfigured, sesSetup } = await import('../lib/ses')
const { settleDomainNow } = await import('@/features/domains/queries/settle')

describe('SES not configured', () => {
  it('the route answers 503 with a reason, and asks nothing', async () => {
    const calls = mockRpc({})
    const response = await handleSesJobs(
      new Request('https://emails.example/api/jobs/ses', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'ses_not_configured' })
    expect(calls).toHaveLength(0)
  })

  it('names what is missing', () => {
    expect(() => sesSetup()).toThrow(SesNotConfigured)
    expect(() => sesSetup()).toThrow('MAIL_SES_MANAGER_ACCESS_KEY_ID')
  })

  it('the domains page leaves the work for later', async () => {
    expect(
      await settleDomainNow({
        accountId: '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e',
        domainId: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
      }),
    ).toBe('later')
  })
})
