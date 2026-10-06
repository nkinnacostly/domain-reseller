import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeSes, useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { ACCOUNT_ID, domainItem, fakeJobsSql, provisioningItem, TOKEN } from './fake-sql'

/**
 * The SES job route (MAIL-SPEC §4.1, §5, §7.2): its bearer token checked in
 * SQL, the shared sandbox sender read while it is due, accounts provisioned
 * and domains worked under their leases — against a fake SES, a fake DNS and
 * migration 47's functions.
 */

vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test only, not a key: signs nothing'
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events'
})

const { handleSesJobs } = await import('../api/jobs-route')
const { runSesJobs } = await import('../lib/jobs')
const { sesSetup } = await import('../lib/ses')
const { createJobsStore } = await import('../queries/store')
const { createServiceClient } = await import('@/lib/supabase/service')
const { createDnsLookup } = await import('@/features/domains/lib/dns-check')

let ses: FakeSes
beforeEach(() => {
  ses = useFakeSes()
  useFakeDoh(ses)
})

const post = (body: unknown, token: string | null = TOKEN) =>
  new Request('https://emails.example/api/jobs/ses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('the route’s door', () => {
  it('no token, a malformed one, or one SQL does not know: 401, and nothing run', async () => {
    const sql = fakeJobsSql({ accounts: [provisioningItem()] })
    expect((await handleSesJobs(post({}, null))).status).toBe(401)
    expect((await handleSesJobs(post({}, 'short'))).status).toBe(401)
    const wrong = await handleSesJobs(post({}, 'b'.repeat(64)))
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ ok: false, error: 'unauthorized' })
    expect(sql.calls.map((call) => call.fn)).toEqual(['begin_ses_jobs'])
    expect(ses.calls).toHaveLength(0)
  })

  it('the right token runs the jobs and answers counts only, never cached', async () => {
    fakeJobsSql({ accounts: [provisioningItem()], domains: [domainItem()] })
    const response = await handleSesJobs(post({}))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      side: 'real',
      sandbox: null,
      accounts: { ready: 1 },
      domains: { pending: 1 },
    })
  })

  it('pg_net’s call for a new account provisions that account first', async () => {
    const sql = fakeJobsSql({ accounts: [provisioningItem()] })
    const response = await handleSesJobs(post({ accountId: ACCOUNT_ID }))
    expect(response.status).toBe(200)
    const claims = sql.calls.filter((call) => call.fn === 'claim_provisioning_work')
    expect(claims[0]?.body).toEqual({
      p_worker: expect.stringMatching(/^jobs:/),
      p_limit: 1,
      p_e2e: false,
      p_account_id: ACCOUNT_ID,
    })
  })

  it('a body that is not JSON is no account in particular', async () => {
    const sql = fakeJobsSql()
    expect((await handleSesJobs(post('not json'))).status).toBe(200)
    expect(
      sql.calls.find((call) => call.fn === 'claim_provisioning_work')?.body,
    ).not.toHaveProperty('p_account_id')
  })

  it('the database failing is a 500 with no detail', async () => {
    fakeJobsSql()
    const { server } = await import('../../../../tests/mocks/server')
    const { http, HttpResponse } = await import('msw')
    server.use(
      http.post('http://127.0.0.1:54321/rest/v1/rpc/claim_provisioning_work', () =>
        HttpResponse.json({ code: '08006', message: 'down' }, { status: 503 }),
      ),
    )
    const response = await handleSesJobs(post({}))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: 'internal_error' })
  })
})

describe('a run', () => {
  function deps() {
    return {
      ses: sesSetup(),
      store: createJobsStore(createServiceClient()),
      lookup: createDnsLookup(),
      worker: 'jobs:test',
    }
  }
  const begun = (due: boolean) => ({
    ok: true as const,
    sandbox: {
      name: 'sandbox.emails.mydomainshub.com',
      fromAddress: 'onboarding@sandbox.emails.mydomainshub.com',
      status: 'not_created' as const,
      identityArn: null,
      due,
    },
  })

  it('reads the shared sandbox sender while it is due, and records what SES says', async () => {
    const sql = fakeJobsSql()
    expect((await runSesJobs(deps(), begun(true))).sandbox).toBe('not_created')
    ses.handle('POST', '/v2/email/identities', { EmailIdentity: 'sandbox.emails.mydomainshub.com' })
    ses.verify('sandbox.emails.mydomainshub.com')
    expect((await runSesJobs(deps(), begun(true))).sandbox).toBe('verified')
    const recorded = sql.calls.filter((call) => call.fn === 'record_sandbox_identity')
    expect(recorded[1]?.body.p_state).toMatchObject({
      status: 'verified',
      identityArn: 'arn:aws:ses:eu-west-2:111122223333:identity/sandbox.emails.mydomainshub.com',
    })
  })

  it('SES not answering about the sandbox sender is said, and the run goes on', async () => {
    fakeJobsSql({ domains: [domainItem({ work: 'teardown', status: 'removing' })] })
    ses.failNext('GET', '/identities/sandbox.emails.mydomainshub.com', 503)
    const summary = await runSesJobs(deps(), begun(true))
    expect(summary).toEqual({ sandbox: 'unanswered', accounts: {}, domains: { released: 1 } })
  })

  it('stops claiming once its time is spent', async () => {
    const sql = fakeJobsSql({ accounts: [provisioningItem()], domains: [domainItem()] })
    let clock = 0
    // Started at 0, given 1.5 s; each look at the clock is a second later.
    const summary = await runSesJobs({ ...deps(), now: () => clock++ * 1_000 }, begun(false), {
      budgetMs: 1_500,
    })
    expect(summary.accounts).toEqual({ ready: 1 })
    expect(summary.domains).toEqual({})
    expect(sql.calls.some((call) => call.fn === 'claim_domain_work')).toBe(false)
  })

  it('the mock side never speaks for the sandbox sender, and claims only test accounts', async () => {
    const sql = fakeJobsSql()
    const mock = { ...deps().ses, side: 'mock' as const }
    expect((await runSesJobs({ ...deps(), ses: mock }, begun(true))).sandbox).toBeNull()
    expect(sql.calls.find((call) => call.fn === 'claim_domain_work')?.body.p_e2e).toBe(true)
    expect(sql.calls.some((call) => call.fn === 'record_sandbox_identity')).toBe(false)
  })
})
