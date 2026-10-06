import { describe, expect, it } from 'vitest'
import { createSesManager, getSesAccount, MAIL_EVENT_TYPES } from './manage'
import { sesCall } from './request'
import { canonicalRequest } from './sigv4'
import { EXAMPLE_CREDENTIALS, recordingFetch } from './test-fetch'

/**
 * Each management call against its recorded request shape — method, path
 * and body as the SES API v2 reference gives them (read 6 Oct 2026) — and
 * signed: the authorization header names the ses service in eu-west-2 and
 * signs the body we send. Answers are AWS's documented examples.
 */

const BASE = 'https://email.eu-west-2.amazonaws.com/v2/email'
const TENANT_ARN = 'arn:aws:ses:eu-west-2:085568227110:tenant/mdm-0a1b2c3d4e/tn-1'
const SET_ARN = 'arn:aws:ses:eu-west-2:085568227110:configuration-set/mdm-0a1b2c3d4e'
const TOPIC = 'arn:aws:sns:eu-west-2:085568227110:mail-ses-events'

function manager(...answers: Parameters<typeof recordingFetch>) {
  const recorded = recordingFetch(...answers)
  return {
    ses: createSesManager({ ...EXAMPLE_CREDENTIALS, fetch: recorded.fetch }),
    calls: recorded.calls,
  }
}

type Recorded = ReturnType<typeof recordingFetch>['calls'][number]

function expectSigned(call: Recorded | undefined, withBody: boolean) {
  expect(call?.init.headers['x-amz-date']).toBe('20261006T093000Z')
  expect(call?.init.headers.authorization).toMatch(
    new RegExp(
      `^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261006/eu-west-2/ses/aws4_request, SignedHeaders=${withBody ? 'content-type;' : ''}host;x-amz-date, Signature=[0-9a-f]{64}$`,
    ),
  )
  if (withBody) expect(call?.init.headers['content-type']).toBe('application/json')
  else expect(call?.init.body).toBeUndefined()
}

const shape = (call: Recorded | undefined) => ({
  method: call?.init.method,
  url: call?.url,
  body: call?.init.body === undefined ? undefined : JSON.parse(call.init.body),
})

describe('identities (§5)', () => {
  it('CreateEmailIdentity: Easy DKIM at RSA 2048, the account’s set, and the three tokens back', async () => {
    const { ses, calls } = manager({
      status: 200,
      body: {
        IdentityType: 'DOMAIN',
        VerifiedForSendingStatus: false,
        DkimAttributes: { SigningEnabled: true, Status: 'PENDING', Tokens: ['t1', 't2', 't3'] },
      },
    })
    expect(
      await ses.createEmailIdentity('acme.example', { configurationSetName: 'mdm-0a1b2c3d4e' }),
    ).toEqual({
      ok: true,
      verificationStatus: null,
      verifiedForSending: false,
      dkimStatus: 'PENDING',
      dkimTokens: ['t1', 't2', 't3'],
      mailFromDomain: null,
      mailFromStatus: null,
      configurationSetName: null,
    })
    expect(shape(calls[0])).toEqual({
      method: 'POST',
      url: `${BASE}/identities`,
      body: {
        EmailIdentity: 'acme.example',
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
        ConfigurationSetName: 'mdm-0a1b2c3d4e',
      },
    })
    expectSigned(calls[0], true)
  })

  it('GetEmailIdentity: a GET with no body, read into the fields the domain page needs', async () => {
    const { ses, calls } = manager({
      status: 200,
      body: {
        IdentityType: 'DOMAIN',
        VerificationStatus: 'SUCCESS',
        VerifiedForSendingStatus: true,
        DkimAttributes: { Status: 'SUCCESS', Tokens: ['t1', 2, 't3'] },
        MailFromAttributes: {
          MailFromDomain: 'send.acme.example',
          MailFromDomainStatus: 'PENDING',
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        },
        ConfigurationSetName: 'mdm-0a1b2c3d4e',
      },
    })
    expect(await ses.getEmailIdentity('acme.example')).toEqual({
      ok: true,
      verificationStatus: 'SUCCESS',
      verifiedForSending: true,
      dkimStatus: 'SUCCESS',
      dkimTokens: ['t1', 't3'],
      mailFromDomain: 'send.acme.example',
      mailFromStatus: 'PENDING',
      configurationSetName: 'mdm-0a1b2c3d4e',
    })
    expect(shape(calls[0])).toEqual({
      method: 'GET',
      url: `${BASE}/identities/acme.example`,
      body: undefined,
    })
    expectSigned(calls[0], false)
  })

  it('DeleteEmailIdentity', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.deleteEmailIdentity('acme.example')).toEqual({ ok: true })
    expect(shape(calls[0])).toEqual({
      method: 'DELETE',
      url: `${BASE}/identities/acme.example`,
      body: undefined,
    })
    expectSigned(calls[0], false)
  })

  it('PutEmailIdentityMailFromAttributes: send.<domain>, the default domain on an MX failure', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(
      await ses.putEmailIdentityMailFromAttributes('acme.example', 'send.acme.example'),
    ).toEqual({ ok: true })
    expect(shape(calls[0])).toEqual({
      method: 'PUT',
      url: `${BASE}/identities/acme.example/mail-from`,
      body: { MailFromDomain: 'send.acme.example', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' },
    })
    expectSigned(calls[0], true)
    await expect(
      ses.putEmailIdentityMailFromAttributes('acme.example', 'send.other.example'),
    ).rejects.toThrow('MAIL FROM')
  })

  it('PutEmailIdentityConfigurationSetAttributes', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(
      await ses.putEmailIdentityConfigurationSetAttributes('acme.example', 'mdm-0a1b2c3d4e'),
    ).toEqual({ ok: true })
    expect(shape(calls[0])).toEqual({
      method: 'PUT',
      url: `${BASE}/identities/acme.example/configuration-set`,
      body: { ConfigurationSetName: 'mdm-0a1b2c3d4e' },
    })
    expectSigned(calls[0], true)
  })

  it('refuses a name that is not a domain before signing anything', async () => {
    const { ses, calls } = manager({ status: 200 })
    await expect(ses.getEmailIdentity('../account')).rejects.toThrow('the domain')
    await expect(ses.createEmailIdentity('ACME.example')).rejects.toThrow('the domain')
    await expect(
      ses.createEmailIdentity('acme.example', { configurationSetName: 'bad name' }),
    ).rejects.toThrow('configuration set')
    expect(calls).toHaveLength(0)
  })
})

describe('tenants and configuration sets (§4.1)', () => {
  it('CreateTenant: its own suppression list for bounces and complaints', async () => {
    const { ses, calls } = manager({
      status: 200,
      body: {
        TenantName: 'mdm-0a1b2c3d4e',
        TenantId: 'tn-1',
        TenantArn: TENANT_ARN,
        SendingStatus: 'ENABLED',
      },
    })
    expect(await ses.createTenant('mdm-0a1b2c3d4e')).toEqual({
      ok: true,
      tenantArn: TENANT_ARN,
      tenantId: 'tn-1',
      sendingStatus: 'ENABLED',
    })
    expect(shape(calls[0])).toEqual({
      method: 'POST',
      url: `${BASE}/tenants`,
      body: {
        TenantName: 'mdm-0a1b2c3d4e',
        SuppressionAttributes: {
          SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
          SuppressionScope: 'TENANT',
        },
      },
    })
    expectSigned(calls[0], true)
  })

  it('CreateTenantResourceAssociation', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.createTenantResourceAssociation('mdm-0a1b2c3d4e', SET_ARN)).toEqual({
      ok: true,
    })
    expect(shape(calls[0])).toEqual({
      method: 'POST',
      url: `${BASE}/tenants/resources`,
      body: { TenantName: 'mdm-0a1b2c3d4e', ResourceArn: SET_ARN },
    })
    expectSigned(calls[0], true)
    await expect(
      ses.createTenantResourceAssociation('mdm-0a1b2c3d4e', 'not-an-arn'),
    ).rejects.toThrow('ARN')
  })

  it('CreateConfigurationSet: reputation metrics on, no open or click tracking', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.createConfigurationSet('mdm-0a1b2c3d4e')).toEqual({ ok: true })
    expect(shape(calls[0])).toEqual({
      method: 'POST',
      url: `${BASE}/configuration-sets`,
      body: {
        ConfigurationSetName: 'mdm-0a1b2c3d4e',
        ReputationOptions: { ReputationMetricsEnabled: true },
        SendingOptions: { SendingEnabled: true },
      },
    })
    expectSigned(calls[0], true)
  })

  it('CreateConfigurationSetEventDestination: the seven events to the mail-ses-events topic', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(
      await ses.createConfigurationSetEventDestination('mdm-0a1b2c3d4e', 'mail-ses-events', TOPIC),
    ).toEqual({
      ok: true,
    })
    expect(shape(calls[0])).toEqual({
      method: 'POST',
      url: `${BASE}/configuration-sets/mdm-0a1b2c3d4e/event-destinations`,
      body: {
        EventDestinationName: 'mail-ses-events',
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [
            'SEND',
            'DELIVERY',
            'BOUNCE',
            'COMPLAINT',
            'REJECT',
            'DELIVERY_DELAY',
            'RENDERING_FAILURE',
          ],
          SnsDestination: { TopicArn: TOPIC },
        },
      },
    })
    expect(MAIL_EVENT_TYPES).not.toContain('OPEN')
    expectSigned(calls[0], true)
    await expect(
      ses.createConfigurationSetEventDestination('mdm-0a1b2c3d4e', 'x', 'arn:aws:sqs:x'),
    ).rejects.toThrow('topic')
  })
})

describe('reputation (§4.1.4, §7.4, MR5)', () => {
  it('UpdateReputationEntityPolicy: the ARN as one path segment, encoded twice to sign', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.updateReputationEntityPolicy(TENANT_ARN, 'strict')).toEqual({ ok: true })
    const encoded = 'arn%3Aaws%3Ases%3Aeu-west-2%3A085568227110%3Atenant%2Fmdm-0a1b2c3d4e%2Ftn-1'
    expect(shape(calls[0])).toEqual({
      method: 'PUT',
      url: `${BASE}/reputation/entities/RESOURCE/${encoded}/policy`,
      body: { ReputationEntityPolicy: 'arn:aws:ses:eu-west-2:aws:reputation-policy/strict' },
    })
    expectSigned(calls[0], true)
    const canonical = await canonicalRequest({
      method: 'PUT',
      url: calls[0]?.url ?? '',
      headers: { 'content-type': 'application/json', 'x-amz-date': '20261006T093000Z' },
      body: calls[0]?.init.body ?? '',
    })
    expect(canonical.text.split('\n')[1]).toBe(
      `/v2/email/reputation/entities/RESOURCE/${encoded.replace(/%/g, '%25')}/policy`,
    )
  })

  it('UpdateReputationEntityCustomerManagedStatus: our pause needs nothing; sending again needs an admin’s reason', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.updateReputationEntityCustomerManagedStatus(TENANT_ARN, 'DISABLED')).toEqual({
      ok: true,
    })
    expect(shape(calls[0])).toMatchObject({
      method: 'PUT',
      url: `${BASE}/reputation/entities/RESOURCE/arn%3Aaws%3Ases%3Aeu-west-2%3A085568227110%3Atenant%2Fmdm-0a1b2c3d4e%2Ftn-1/customer-managed-status`,
      body: { SendingStatus: 'DISABLED' },
    })
    expectSigned(calls[0], true)
    await expect(
      ses.updateReputationEntityCustomerManagedStatus(TENANT_ARN, 'ENABLED'),
    ).rejects.toThrow('MR5')
    await expect(
      ses.updateReputationEntityCustomerManagedStatus(TENANT_ARN, 'REINSTATED', 'short'),
    ).rejects.toThrow('MR5')
    expect(
      await ses.updateReputationEntityCustomerManagedStatus(
        TENANT_ARN,
        'ENABLED',
        'Bounce source removed, list cleaned',
      ),
    ).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })
})

describe('the account (§4.4)', () => {
  it('GetAccount: the shared quota', async () => {
    const { ses, calls } = manager({
      status: 200,
      body: {
        SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 1234 },
        SendingEnabled: true,
        ProductionAccessEnabled: true,
      },
    })
    expect(await ses.getAccount()).toEqual({
      ok: true,
      quota: { max24HourSend: 50000, maxSendRate: 14, sentLast24Hours: 1234, sendingEnabled: true },
    })
    expect(shape(calls[0])).toEqual({ method: 'GET', url: `${BASE}/account`, body: undefined })
    expectSigned(calls[0], false)
  })

  it('reads a missing or odd quota as unknown', async () => {
    const { fetch } = recordingFetch({ status: 200, body: 'not json' })
    expect(await getSesAccount({ ...EXAMPLE_CREDENTIALS, fetch })).toEqual({
      ok: true,
      quota: {
        max24HourSend: null,
        maxSendRate: null,
        sentLast24Hours: null,
        sendingEnabled: false,
      },
    })
  })
})

describe('failures, as status and type only', () => {
  it.each([
    [
      {
        status: 400,
        errorType: 'AlreadyExistsException',
        body: { message: 'acme.example exists' },
      },
      false,
      'AlreadyExistsException',
    ],
    [
      { status: 404, body: { __type: 'com.amazonaws.sesv2#NotFoundException' } },
      false,
      'NotFoundException',
    ],
    [{ status: 429, errorType: 'TooManyRequestsException' }, true, 'TooManyRequestsException'],
    [{ status: 503 }, true, null],
  ])('%j', async (answer, retryable, code) => {
    const { ses } = manager(answer)
    const outcome = await ses.getEmailIdentity('acme.example')
    expect(outcome).toMatchObject({ ok: false, status: answer.status, code, retryable })
    expect(JSON.stringify(outcome)).not.toContain('acme.example exists')
  })

  it('every call passes a failure through', async () => {
    const { ses } = manager({ status: 400, errorType: 'BadRequestException' })
    const failure = { ok: false, code: 'BadRequestException', retryable: false }
    expect(await ses.createEmailIdentity('acme.example')).toMatchObject(failure)
    expect(await ses.createTenant('mdm-0a1b2c3d4e')).toMatchObject(failure)
    expect(await ses.deleteEmailIdentity('acme.example')).toMatchObject(failure)
    expect(await ses.getAccount()).toMatchObject(failure)
  })

  it('no answer and an unreachable SES are worth another try', async () => {
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    expect(
      await sesCall(
        { ...EXAMPLE_CREDENTIALS, fetch: recordingFetch(aborted).fetch },
        { method: 'GET', path: '/account' },
      ),
    ).toEqual({
      ok: false,
      status: null,
      code: null,
      retryable: true,
      error: 'no answer from SES',
    })
    expect(
      await sesCall(
        { ...EXAMPLE_CREDENTIALS, fetch: recordingFetch(new TypeError('fetch failed')).fetch },
        { method: 'GET', path: '/account' },
      ),
    ).toMatchObject({ error: 'could not reach SES' })
  })

  it('refuses settings it cannot sign with', () => {
    expect(() => createSesManager({ ...EXAMPLE_CREDENTIALS, region: 'nowhere' })).toThrow('region')
  })
})

describe('the tenant’s suppression list (§7.5)', () => {
  it('DeleteSuppressedDestination: the address as SES holds it, on the tenant’s own list', async () => {
    const { ses, calls } = manager({ status: 200 })
    expect(await ses.deleteSuppressedDestination('Ada.Obi@Example.com', 'mdm-0a1b2c3d4e')).toEqual({
      ok: true,
      found: true,
    })
    expect(shape(calls[0])).toEqual({
      method: 'DELETE',
      url: `${BASE}/suppression/addresses/Ada.Obi%40Example.com?TenantName=mdm-0a1b2c3d4e`,
      body: undefined,
    })
    expectSigned(calls[0], false)
    // SigV4 signs each path segment encoded again, and the tenant as a query parameter.
    const signed = await canonicalRequest({
      method: 'DELETE',
      url: calls[0]?.url ?? '',
      headers: { 'x-amz-date': '20261006T093000Z' },
    })
    expect(signed.text.split('\n').slice(0, 3)).toEqual([
      'DELETE',
      '/v2/email/suppression/addresses/Ada.Obi%2540Example.com',
      'TenantName=mdm-0a1b2c3d4e',
    ])
  })

  it('an address that is not on the list is already removed', async () => {
    const { ses } = manager({ status: 404, errorType: 'NotFoundException' })
    expect(await ses.deleteSuppressedDestination('ada@example.com', 'mdm-0a1b2c3d4e')).toEqual({
      ok: true,
      found: false,
    })
  })

  it('anything else is SES’s refusal, by status and type only', async () => {
    const { ses } = manager({ status: 429, errorType: 'TooManyRequestsException' })
    expect(
      await ses.deleteSuppressedDestination('ada@example.com', 'mdm-0a1b2c3d4e'),
    ).toMatchObject({ ok: false, status: 429, code: 'TooManyRequestsException', retryable: true })
  })

  it('refuses an address or a tenant it would not send', async () => {
    const { ses, calls } = manager({ status: 200 })
    await expect(
      ses.deleteSuppressedDestination('not an address', 'mdm-0a1b2c3d4e'),
    ).rejects.toThrow('address')
    await expect(ses.deleteSuppressedDestination('ada@example.com', 'mdm/../x')).rejects.toThrow(
      'tenant',
    )
    expect(calls).toHaveLength(0)
  })
})
