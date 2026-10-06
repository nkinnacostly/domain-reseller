import { MAIL_EVENT_TYPES } from '@dr/shared/ses'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeSes, useFakeSes } from '../../../../tests/mocks/ses'
import { ACCOUNT_ID, fakeJobsSql, provisioningItem } from './fake-sql'

/**
 * Provisioning an account's SES tenant (MAIL-SPEC §4.1) against a fake SES and
 * migration 47's functions: every step read before it is written, recorded as
 * SES answered, resumed rather than repeated, and SES's refusals kept as
 * status and type only.
 */

const env = vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test only, not a key: signs nothing'
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events'
  return { topic: 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events' }
})

const { sesSetup, retryAfterSeconds, redirectFetch } = await import('../lib/ses')
const { runProvisioning } = await import('../lib/provision')
const { createJobsStore, provisioningWorkSchema } = await import('../queries/store')
const { createServiceClient } = await import('@/lib/supabase/service')

const TENANT = 'mdm-0a1b2c3d4e'
const SET_ARN = `arn:aws:ses:eu-west-2:111122223333:configuration-set/${TENANT}`

let ses: FakeSes
beforeEach(() => {
  ses = useFakeSes()
})

function deps() {
  return { ses: sesSetup(), store: createJobsStore(createServiceClient()), worker: 'test-1' }
}

const item = (overrides: Record<string, unknown> = {}) =>
  provisioningWorkSchema.parse(provisioningItem(overrides))

const created = (method: string, path: string) =>
  ses.calls.filter((call) => call.method === method && call.path === path).length

describe('a new account (§4.1)', () => {
  it('gets its tenant, set, destination, association and Strict policy, then is ready', async () => {
    const sql = fakeJobsSql()
    expect(await runProvisioning(item(), deps())).toBe('ready')

    const tenant = ses.tenants.get(TENANT)
    expect(tenant?.SuppressionAttributes).toEqual({
      SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
      SuppressionScope: 'TENANT',
    })
    expect(ses.sets.get(TENANT)?.get('mail-ses-events')).toEqual({
      Enabled: true,
      MatchingEventTypes: [...MAIL_EVENT_TYPES],
      SnsDestination: { TopicArn: env.topic },
    })
    expect([...(ses.resources.get(TENANT) ?? [])]).toEqual([SET_ARN])
    expect(ses.policies.get(tenant?.TenantArn)).toBe(
      'arn:aws:ses:eu-west-2:aws:reputation-policy/strict',
    )
    expect(sql.args('record_provisioning', 'p_step')).toEqual([
      'tenant',
      'suppression',
      'config_set',
      'event_destination',
      'config_set_association',
      'policy',
      'done',
    ])
    const tenantStep = sql.calls.find(
      (call) => call.fn === 'record_provisioning' && call.body.p_step === 'tenant',
    )
    expect(tenantStep?.body).toMatchObject({
      p_account_id: ACCOUNT_ID,
      p_worker: 'test-1',
      p_detail: { tenantArn: tenant?.TenantArn, sendingStatus: 'ENABLED' },
    })
    expect(tenantStep?.auth).toBe('Bearer sb_test')
  })

  it('an account past 30 days goes straight to Standard: SES’s default, read and left', async () => {
    const sql = fakeJobsSql()
    expect(await runProvisioning(item({ policy: 'standard' }), deps())).toBe('ready')
    const arn = ses.tenants.get(TENANT)?.TenantArn
    expect(created('GET', `/reputation/entities/RESOURCE/${arn}`)).toBe(1)
    expect(created('PUT', `/reputation/entities/RESOURCE/${arn}/policy`)).toBe(0)
    expect(sql.calls.find((call) => call.body.p_step === 'policy')?.body.p_detail).toEqual({
      policy: 'standard',
    })
  })
})

describe('a half-done provisioning resumes, never duplicates', () => {
  it('reads what SES has, writes only what is missing or wrong', async () => {
    ses.handle('POST', '/v2/email/tenants', { TenantName: TENANT })
    ses.handle('POST', '/v2/email/configuration-sets', { ConfigurationSetName: TENANT })
    ses.handle('POST', `/v2/email/configuration-sets/${TENANT}/event-destinations`, {
      EventDestinationName: 'mail-ses-events',
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ['SEND'],
        SnsDestination: { TopicArn: env.topic },
      },
    })
    ses.handle('POST', '/v2/email/tenants/resources', { TenantName: TENANT, ResourceArn: SET_ARN })
    const arn = ses.tenants.get(TENANT)?.TenantArn as string
    ses.policies.set(arn, 'arn:aws:ses:eu-west-2:aws:reputation-policy/strict')
    ses.calls.length = 0
    const sql = fakeJobsSql()

    expect(await runProvisioning(item(), deps())).toBe('ready')
    expect(created('POST', '/tenants')).toBe(0)
    expect(created('POST', '/configuration-sets')).toBe(0)
    expect(created('POST', '/tenants/resources')).toBe(0)
    expect(created('PUT', `/reputation/entities/RESOURCE/${arn}/policy`)).toBe(0)
    // Made without its own list: given one. The destination had one event: all seven.
    expect(created('POST', '/tenant/suppression')).toBe(1)
    expect(ses.tenants.get(TENANT)?.SuppressionAttributes?.SuppressionScope).toBe('TENANT')
    expect(created('PUT', `/configuration-sets/${TENANT}/event-destinations/mail-ses-events`)).toBe(
      1,
    )
    expect(sql.args('record_provisioning', 'p_step')).toContain('event_destination')
  })

  it('steps already recorded are not asked again', async () => {
    ses.handle('POST', '/v2/email/tenants', {
      TenantName: TENANT,
      SuppressionAttributes: {
        SuppressionScope: 'TENANT',
        SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
      },
    })
    ses.calls.length = 0
    const sql = fakeJobsSql()
    const steps = {
      tenant: true,
      suppression: true,
      configSet: true,
      eventDestination: true,
      configSetAssociated: true,
      strictPolicy: false,
      standardPolicy: false,
      sandboxAssociated: false,
    }
    await runProvisioning(item({ steps }), deps())
    expect(ses.calls.map((call) => `${call.method} ${call.path.split('/')[1]}`)).toEqual([
      'POST tenants',
      'GET reputation',
      'PUT reputation',
    ])
    expect(sql.args('record_provisioning', 'p_step')).toEqual(['tenant', 'policy', 'done'])
  })

  it('a tenant made by a run that raced this one is read, not made twice', async () => {
    ses.failNext('POST', '/tenants/get', 404, 'NotFoundException')
    ses.handle('POST', '/v2/email/tenants', { TenantName: TENANT })
    ses.calls.length = 0
    fakeJobsSql()
    expect(await runProvisioning(item(), deps())).toBe('ready')
    expect(created('POST', '/tenants')).toBe(1)
    expect(created('POST', '/tenants/get')).toBe(2)
    expect(ses.tenants.size).toBe(1)
  })
})

describe('after 30 days, and the sandbox sender (§4.1.4, §7.2)', () => {
  const ready = {
    tenant: true,
    suppression: true,
    configSet: true,
    eventDestination: true,
    configSetAssociated: true,
    strictPolicy: true,
    standardPolicy: false,
    sandboxAssociated: false,
  }

  it('moves a ready tenant from Strict to Standard', async () => {
    ses.handle('POST', '/v2/email/tenants', { TenantName: TENANT })
    const arn = ses.tenants.get(TENANT)?.TenantArn as string
    ses.policies.set(arn, 'arn:aws:ses:eu-west-2:aws:reputation-policy/strict')
    const sql = fakeJobsSql()
    expect(
      await runProvisioning(
        item({
          tenantReady: true,
          tenantArn: arn,
          steps: ready,
          work: ['policy'],
          policy: 'standard',
        }),
        deps(),
      ),
    ).toBe('done')
    expect(ses.policies.get(arn)).toBe('arn:aws:ses:eu-west-2:aws:reputation-policy/standard')
    expect(sql.calls.find((call) => call.body.p_step === 'policy')?.body.p_detail).toEqual({
      policy: 'standard',
    })
  })

  it('joins the shared identity to a sandbox account’s tenant, and takes it off on leaving', async () => {
    ses.handle('POST', '/v2/email/tenants', { TenantName: TENANT })
    const arn = ses.tenants.get(TENANT)?.TenantArn as string
    const identity = 'arn:aws:ses:eu-west-2:111122223333:identity/sandbox.emails.mydomainshub.com'
    const sandbox = {
      name: 'sandbox.emails.mydomainshub.com',
      fromAddress: 'onboarding@sandbox.emails.mydomainshub.com',
      status: 'verified',
      identityArn: identity,
    }
    let sql = fakeJobsSql()
    await runProvisioning(
      item({ tenantReady: true, tenantArn: arn, steps: ready, work: ['sandbox_join'], sandbox }),
      deps(),
    )
    expect(ses.resources.get(TENANT)?.has(identity)).toBe(true)
    expect(sql.args('record_provisioning', 'p_step')).toEqual(['sandbox_join', 'done'])

    sql = fakeJobsSql()
    await runProvisioning(
      item({
        state: 'active',
        tenantReady: true,
        tenantArn: arn,
        steps: { ...ready, sandboxAssociated: true },
        work: ['sandbox_leave'],
        sandbox,
      }),
      deps(),
    )
    expect(ses.resources.get(TENANT)?.has(identity)).toBe(false)
    expect(sql.args('record_provisioning', 'p_step')).toEqual(['sandbox_leave', 'done'])
  })
})

describe('when SES refuses or does not answer', () => {
  it('records the status and type, backs off, and stops', async () => {
    ses.failNext('POST', '/tenants/get', 503)
    const sql = fakeJobsSql()
    expect(await runProvisioning(item(), deps())).toBe('error')
    expect(sql.calls.filter((call) => call.fn === 'record_provisioning_error')[0]?.body).toEqual({
      p_account_id: ACCOUNT_ID,
      p_worker: 'test-1',
      p_error: 'HTTP 503',
      p_retry_after: 60,
    })
    expect(sql.args('record_provisioning', 'p_step')).toEqual([])
  })

  it('a refusal backs off for longer', async () => {
    ses.failNext('POST', '/configuration-sets', 400, 'BadRequestException')
    const sql = fakeJobsSql()
    expect(await runProvisioning(item({ attempts: 1 }), deps())).toBe('error')
    expect(sql.calls.find((call) => call.fn === 'record_provisioning_error')?.body).toMatchObject({
      p_error: 'HTTP 400 BadRequestException',
      p_retry_after: 1800,
    })
  })

  it('a lease another run now holds ends this one quietly', async () => {
    fakeJobsSql({ refuse: { record_provisioning: 'lease_lost' } })
    expect(await runProvisioning(item(), deps())).toBe('lost')
  })

  it('backs off by attempts, capped', () => {
    const failure = {
      ok: false as const,
      status: 503,
      code: null,
      retryable: true,
      error: 'HTTP 503',
    }
    expect(retryAfterSeconds(failure, 0)).toBe(60)
    expect(retryAfterSeconds(failure, 3)).toBe(480)
    expect(retryAfterSeconds(failure, 40)).toBe(3600)
    expect(retryAfterSeconds({ ...failure, retryable: false }, -1)).toBe(900)
    expect(retryAfterSeconds({ ...failure, retryable: false }, 9)).toBe(21600)
  })
})

describe('the SES set-up', () => {
  it('is the real side with the manager key, its account from the topic', () => {
    const setup = sesSetup()
    expect(setup).toMatchObject({ side: 'real', region: 'eu-west-2', awsAccount: '111122223333' })
  })

  it('a mock endpoint takes every SES request, path unchanged', async () => {
    const seen: string[] = []
    const fake = redirectFetch('eu-west-2', 'http://127.0.0.1:4312/')
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      seen.push(url)
      return new Response('{}')
    }) as typeof fetch
    try {
      await fake('https://email.eu-west-2.amazonaws.com/v2/email/tenants', {
        method: 'GET',
        headers: {},
      })
      await fake('https://elsewhere.example/x', { method: 'GET', headers: {} })
    } finally {
      globalThis.fetch = original
    }
    expect(seen).toEqual(['http://127.0.0.1:4312/v2/email/tenants', 'https://elsewhere.example/x'])
  })
})
