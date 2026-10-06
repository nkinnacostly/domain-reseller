import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeSes, useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { DOMAIN_ID, domainItem, fakeJobsSql } from '../../tenants/__tests__/fake-sql'

/**
 * One domain's SES work (MAIL-SPEC §5) against a fake SES, a fake public DNS
 * and migration 47's functions: set-up step by step, checks, failing at 72
 * hours naming the missing record, and letting the identity go.
 */

vi.hoisted(() => {
  process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test only, not a key: signs nothing'
  process.env.MAIL_SES_EVENTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events'
})

const { sesSetup } = await import('@/features/tenants/lib/ses')
const { createJobsStore, domainWorkSchema } = await import('@/features/tenants/queries/store')
const { createServiceClient } = await import('@/lib/supabase/service')
const { createDnsLookup } = await import('../lib/dns-check')
const { runDomainWork, SETUP_REFUSALS_BEFORE_FAILING } = await import('../lib/run')

const TENANT = 'mdm-0a1b2c3d4e'
const ARN = 'arn:aws:ses:eu-west-2:111122223333:identity/acme.example'
const DONE = { identity: true, mailFrom: true, configSet: true, tenant: true }

let ses: FakeSes
beforeEach(() => {
  ses = useFakeSes()
  useFakeDoh(ses)
  ses.handle('POST', '/v2/email/tenants', { TenantName: TENANT })
  ses.handle('POST', '/v2/email/configuration-sets', { ConfigurationSetName: TENANT })
  ses.calls.length = 0
})

function deps() {
  return {
    ses: sesSetup(),
    store: createJobsStore(createServiceClient()),
    worker: 'test-d',
    lookup: createDnsLookup(),
  }
}

const item = (overrides: Record<string, unknown> = {}) =>
  domainWorkSchema.parse(domainItem(overrides))

/** An identity as a finished set-up leaves it. */
function setUpInSes() {
  ses.handle('POST', '/v2/email/identities', {
    EmailIdentity: 'acme.example',
    DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
  })
  ses.handle('PUT', '/v2/email/identities/acme.example/mail-from', {
    MailFromDomain: 'send.acme.example',
    BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
  })
  ses.handle('PUT', '/v2/email/identities/acme.example/configuration-set', {
    ConfigurationSetName: TENANT,
  })
  ses.handle('POST', '/v2/email/tenants/resources', { TenantName: TENANT, ResourceArn: ARN })
  ses.calls.length = 0
  return ses.identities.get('acme.example').DkimAttributes.Tokens as string[]
}

describe('setting a domain up (§5.1–5.4)', () => {
  it('identity with Easy DKIM at RSA 2048, MAIL FROM, the account’s set, the tenant — each recorded', async () => {
    const sql = fakeJobsSql()
    expect(await runDomainWork(item(), deps())).toBe('pending')
    const identity = ses.identities.get('acme.example')
    expect(identity.DkimAttributes.NextSigningKeyLength).toBe('RSA_2048_BIT')
    expect(identity.MailFromAttributes).toMatchObject({
      MailFromDomain: 'send.acme.example',
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    })
    expect(identity.ConfigurationSetName).toBe(TENANT)
    expect(ses.resources.get(TENANT)?.has(ARN)).toBe(true)
    expect(sql.args('record_domain_step', 'p_step')).toEqual([
      'identity',
      'mail_from',
      'config_set',
      'tenant',
    ])
    expect(sql.calls.find((call) => call.body.p_step === 'identity')?.body.p_detail).toEqual({
      identityArn: ARN,
      dkimTokens: identity.DkimAttributes.Tokens,
      dkimStatus: 'PENDING',
    })
    expect(sql.calls.find((call) => call.fn === 'record_domain_check')?.body.p_state).toMatchObject(
      {
        found: true,
        verifiedForSending: false,
        dkimStatus: 'PENDING',
      },
    )
  })

  it('waits for the account’s tenant before the set and the association', async () => {
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ tenantReady: false }), deps())).toBe('waiting')
    expect(sql.args('record_domain_step', 'p_step')).toEqual(['identity', 'mail_from'])
    expect(sql.calls.find((call) => call.fn === 'record_domain_error')?.body).toMatchObject({
      p_error: 'tenant not ready',
      p_retry_after: 60,
    })
    expect(ses.resources.get(TENANT)?.size).toBe(0)
  })

  it('resumes: an identity SES already holds is read, never made twice', async () => {
    const tokens = setUpInSes()
    const sql = fakeJobsSql()
    ses.verify('acme.example')
    expect(
      await runDomainWork(
        item({
          dkimTokens: tokens,
          steps: { identity: true, mailFrom: true, configSet: false, tenant: false },
        }),
        deps(),
      ),
    ).toBe('verified')
    expect(ses.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /identities/acme.example',
      'POST /tenants/resources/list',
      'GET /identities/acme.example',
    ])
    expect(sql.args('record_domain_step', 'p_step')).toEqual(['config_set', 'tenant'])
  })

  it('an identity made by a run that raced this one is read back', async () => {
    setUpInSes()
    ses.failNext('GET', '/identities/acme.example', 404, 'NotFoundException')
    fakeJobsSql()
    expect(await runDomainWork(item(), deps())).toBe('pending')
    expect(
      ses.calls.filter((call) => call.method === 'POST' && call.path === '/identities'),
    ).toHaveLength(1)
  })

  it('SES not answering is retried later; refusing four times fails the claim and lets it go', async () => {
    ses.failNext('POST', '/identities', 503)
    let sql = fakeJobsSql()
    expect(await runDomainWork(item(), deps())).toBe('error')
    expect(sql.calls.find((call) => call.fn === 'record_domain_error')?.body).toMatchObject({
      p_error: 'HTTP 503',
      p_retry_after: 60,
    })

    ses.failNext('POST', '/identities', 400, 'BadRequestException')
    sql = fakeJobsSql()
    expect(await runDomainWork(item({ attempts: SETUP_REFUSALS_BEFORE_FAILING - 1 }), deps())).toBe(
      'failed',
    )
    expect(sql.args('record_domain_failed', 'p_reason')).toEqual(['ses_refused'])
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(true)
  })

  it('a lease another run now holds ends this one quietly', async () => {
    fakeJobsSql({ refuse: { record_domain_step: 'lease_lost' } })
    expect(await runDomainWork(item(), deps())).toBe('lost')
  })
})

describe('checks (§5: "Check now", and every 10 minutes)', () => {
  it('verified when SES says so', async () => {
    const tokens = setUpInSes()
    ses.verify('acme.example')
    const sql = fakeJobsSql()
    expect(
      await runDomainWork(item({ work: 'check', steps: DONE, dkimTokens: tokens }), deps()),
    ).toBe('verified')
    expect(sql.calls.find((call) => call.fn === 'record_domain_check')?.body.p_state).toEqual({
      found: true,
      verifiedForSending: true,
      verificationStatus: 'SUCCESS',
      dkimStatus: 'SUCCESS',
      dkimTokens: tokens,
      mailFromStatus: 'SUCCESS',
    })
  })

  it('an identity SES no longer has is reported as not found', async () => {
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ work: 'check', steps: DONE }), deps())).toBe('pending')
    expect(sql.calls.find((call) => call.fn === 'record_domain_check')?.body.p_state).toEqual({
      found: false,
    })
  })

  it('SES unwell during a check: an error, retried', async () => {
    ses.failNext('GET', '/identities/acme.example', 500)
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ work: 'check', steps: DONE }), deps())).toBe('error')
    expect(sql.args('record_domain_error', 'p_error')).toEqual(['HTTP 500'])
  })
})

describe('72 hours unproven (§5)', () => {
  it('fails naming the DKIM record public DNS does not have, then lets the identity go', async () => {
    const tokens = setUpInSes()
    ses.publish(`${tokens[0]}._domainkey.acme.example`, 'CNAME', `${tokens[0]}.dkim.amazonses.com.`)
    const sql = fakeJobsSql()
    expect(
      await runDomainWork(item({ work: 'expire', steps: DONE, dkimTokens: tokens }), deps()),
    ).toBe('failed')
    expect(sql.calls.find((call) => call.fn === 'record_domain_failed')?.body).toMatchObject({
      p_domain_id: DOMAIN_ID,
      p_reason: 'dkim_record_missing',
      p_missing_record: `${tokens[1]}._domainkey.acme.example`,
    })
    expect(ses.identities.has('acme.example')).toBe(false)
    expect(ses.resources.get(TENANT)?.has(ARN)).toBe(false)
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(true)
  })

  it('records all in DNS but SES not satisfied: not verified, no record named', async () => {
    const tokens = setUpInSes()
    ses.publishRecords('acme.example')
    const sql = fakeJobsSql()
    expect(
      await runDomainWork(item({ work: 'expire', steps: DONE, dkimTokens: tokens }), deps()),
    ).toBe('failed')
    expect(sql.calls.find((call) => call.fn === 'record_domain_failed')?.body).toMatchObject({
      p_reason: 'dkim_not_verified',
    })
    expect(sql.calls.find((call) => call.fn === 'record_domain_failed')?.body).not.toHaveProperty(
      'p_missing_record',
    )
  })

  it('never set up: not set up', async () => {
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ work: 'expire' }), deps())).toBe('failed')
    expect(sql.args('record_domain_failed', 'p_reason')).toEqual(['not_set_up'])
  })

  it('verified at the last moment: verified, not failed', async () => {
    const tokens = setUpInSes()
    ses.verify('acme.example')
    const sql = fakeJobsSql()
    expect(
      await runDomainWork(item({ work: 'expire', steps: DONE, dkimTokens: tokens }), deps()),
    ).toBe('verified')
    expect(sql.calls.some((call) => call.fn === 'record_domain_failed')).toBe(false)
  })
})

describe('letting an identity go (§5 removal)', () => {
  it('off the tenant, then deleted, then released', async () => {
    setUpInSes()
    const sql = fakeJobsSql()
    expect(
      await runDomainWork(item({ work: 'teardown', status: 'removing', steps: DONE }), deps()),
    ).toBe('released')
    expect(ses.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /tenants/resources/delete',
      'DELETE /identities/acme.example',
    ])
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(true)
  })

  it('an identity already gone is released all the same', async () => {
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ work: 'teardown', status: 'removing' }), deps())).toBe(
      'released',
    )
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(true)
  })

  it('SES failing to delete: tried again later', async () => {
    setUpInSes()
    ses.failNext('DELETE', '/identities/acme.example', 503)
    const sql = fakeJobsSql()
    expect(await runDomainWork(item({ work: 'teardown', status: 'removing' }), deps())).toBe(
      'error',
    )
    expect(sql.calls.some((call) => call.fn === 'record_domain_released')).toBe(false)
    expect(sql.args('record_domain_error', 'p_error')).toEqual(['HTTP 503'])
  })

  it('SES failing to take it off the tenant: tried again later', async () => {
    setUpInSes()
    ses.failNext('POST', '/tenants/resources/delete', 429, 'TooManyRequestsException')
    fakeJobsSql()
    expect(await runDomainWork(item({ work: 'teardown', status: 'failed' }), deps())).toBe('error')
    expect(ses.identities.has('acme.example')).toBe(true)
  })
})
