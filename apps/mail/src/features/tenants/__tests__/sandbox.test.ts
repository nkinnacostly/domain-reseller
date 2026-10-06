import { createSesManager } from '@dr/shared/ses'
import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeSes, useFakeSes } from '../../../../tests/mocks/ses'
import { ensureSandboxIdentity, readSandboxIdentity, SANDBOX_NAME } from '../lib/sandbox'

/**
 * The shared sandbox sender (MAIL-SPEC §7.2): the ops script's work — read
 * only unless asked to create — and what the job route records of it.
 */

const where = { name: SANDBOX_NAME, region: 'eu-west-2', awsAccount: '111122223333' }
const manager = () =>
  createSesManager({
    region: 'eu-west-2',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  })

let ses: FakeSes
beforeEach(() => {
  ses = useFakeSes()
})

describe('the ops script', () => {
  it('only reads unless told to create, and says so', async () => {
    const result = await ensureSandboxIdentity(manager(), where, { create: false })
    expect(result).toMatchObject({ ok: true, state: { status: 'not_created' }, records: [] })
    expect(result.ok && result.did[0]).toContain('--create')
    expect(ses.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('with --create, makes the identity and MAIL FROM, and answers the records', async () => {
    const result = await ensureSandboxIdentity(manager(), where, { create: true })
    if (!result.ok) throw new Error('expected ok')
    expect(result.did).toEqual([
      'created the identity sandbox.emails.mydomainshub.com (Easy DKIM, RSA 2048)',
      'set MAIL FROM to send.sandbox.emails.mydomainshub.com',
    ])
    const identity = ses.identities.get(SANDBOX_NAME)
    expect(identity.DkimAttributes.NextSigningKeyLength).toBe('RSA_2048_BIT')
    expect(identity.ConfigurationSetName).toBeUndefined()
    expect(result.state).toMatchObject({
      status: 'pending',
      identityArn: `arn:aws:ses:eu-west-2:111122223333:identity/${SANDBOX_NAME}`,
    })
    expect(result.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      ...identity.DkimAttributes.Tokens.map((t: string) => `CNAME ${t}._domainkey.${SANDBOX_NAME}`),
      `MX send.${SANDBOX_NAME}`,
      `TXT send.${SANDBOX_NAME}`,
      `TXT _dmarc.${SANDBOX_NAME}`,
    ])
    // Run again: nothing new is made.
    const again = await ensureSandboxIdentity(manager(), where, { create: true })
    expect(again.ok && again.did).toEqual([])
  })

  it('stops at SES’s refusal, as status and type only', async () => {
    ses.failNext('POST', '/identities', 400, 'BadRequestException')
    expect(await ensureSandboxIdentity(manager(), where, { create: true })).toMatchObject({
      ok: false,
      error: 'HTTP 400 BadRequestException',
    })
    ses.failNext('GET', '/identities', 503)
    expect(await ensureSandboxIdentity(manager(), where, { create: false })).toMatchObject({
      ok: false,
      retryable: true,
    })
  })

  it('a MAIL FROM SES refuses is reported', async () => {
    ses.handle('POST', '/v2/email/identities', { EmailIdentity: SANDBOX_NAME })
    ses.failNext('PUT', `/identities/${SANDBOX_NAME}/mail-from`, 400, 'BadRequestException')
    expect(await ensureSandboxIdentity(manager(), where, { create: true })).toMatchObject({
      ok: false,
    })
  })
})

describe('what the job route records', () => {
  it('pending, verified or failed, as SES has it', async () => {
    ses.handle('POST', '/v2/email/identities', { EmailIdentity: SANDBOX_NAME })
    expect(await readSandboxIdentity(manager(), where)).toMatchObject({
      state: { status: 'pending' },
    })
    ses.verify(SANDBOX_NAME)
    expect(await readSandboxIdentity(manager(), where)).toMatchObject({
      state: { status: 'verified' },
    })
    ses.fail(SANDBOX_NAME)
    expect(await readSandboxIdentity(manager(), where)).toMatchObject({
      state: { status: 'failed' },
    })
  })
})
