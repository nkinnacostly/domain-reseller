import type { Contact } from '@dr/shared'
import DomainNameApi from 'nodejs-dna'
import { describe, expect, it } from 'vitest'
import { createTransport } from '../dna/transport'
import { Semaphore } from '../lib/semaphore'
import {
  type CallRecord,
  classifyTransferRefusal,
  createDnaRegistrar,
  redact,
  statusWord,
  transferState,
} from './registrar'

/**
 * Transfers in (PRD E9) through the real SDK over a fake network: what
 * CheckTransfer and Transfer send, what we make of each answer, and that the
 * transfer code never reaches the audit record (N13).
 */

type Route = (method: string, path: string, body: unknown) => Response | Promise<Response>

const CODE = 'Zq9!x-TRANSFER-code'
const CONTACT: Contact = {
  firstName: 'Ada',
  lastName: 'Obi',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

/** Who the SDK sent in each role, by the supplier's contact type. */
function firstNameByRole(body: unknown): Record<string, string> {
  const contacts = (body as { contacts?: { contactType: string; firstName: string }[] }).contacts
  return Object.fromEntries((contacts ?? []).map((row) => [row.contactType, row.firstName]))
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const timeout = () => {
  throw new DOMException('The operation timed out.', 'TimeoutError')
}

function setup(route: Route, slots = new Semaphore(2), slotWait?: { waitMs: number }) {
  const client = new DomainNameApi('00000000-0000-0000-0000-000000000000', 'key', {
    testMode: true,
    telemetry: false,
  })
  const sent: { method: string; path: string; body: unknown }[] = []
  client.client._axios = createTransport((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ method, path, body })
    return route(method, path, body)
  }) as typeof fetch)
  const calls: CallRecord[] = []
  const registrar = createDnaRegistrar({
    client,
    environment: 'ote',
    audit: async (call) => {
      calls.push(call)
    },
    slots,
    ...(slotWait ? { slotWait: { ...slotWait, priority: 'high' as const } } : {}),
  })
  return { registrar, calls, sent }
}

describe('checkTransfer (FR-T1)', () => {
  it('asks with the domain and the code, and reads a yes', async () => {
    const { registrar, sent, calls } = setup(() =>
      json(200, { transferAvailabilityStatus: true, authCodeIsValid: true, transferLock: false }),
    )
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toEqual({
      kind: 'ok',
      data: { transferable: true },
    })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/domains/transfers/check',
      body: { domainName: 'getpaid.com', authCode: CODE },
    })
    expect(calls[0]).toMatchObject({ operation: 'CheckTransfer', outcome: 'ok' })
  })

  it.each([
    [
      { authCodeIsValid: false, authCodeIsRequired: true, transferLock: false },
      'AUTH_CODE_INVALID',
    ],
    [{ authCodeIsValid: true, transferLock: true }, 'TRANSFER_LOCKED'],
    [{ authCodeIsValid: false, transferLock: true }, 'TRANSFER_LOCKED'],
    [{ authCodeIsValid: true, transferLock: false }, 'NOT_TRANSFERABLE'],
  ])('reads a no, %o, as %s', async (fields, reason) => {
    const { registrar } = setup(() => json(200, { transferAvailabilityStatus: false, ...fields }))
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toEqual({
      kind: 'ok',
      data: { transferable: false, reason },
    })
  })

  it('never reads an answer without the verdict as a yes', async () => {
    const { registrar } = setup(() => json(200, { message: 'ok' }))
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'UNPARSEABLE',
    })
  })

  it('reads a refused check as a no, and keeps the code out of the record', async () => {
    const { registrar, calls } = setup(() =>
      json(400, { error: { message: `Auth code ${CODE} is not valid for this domain` } }),
    )
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toEqual({
      kind: 'ok',
      data: { transferable: false, reason: 'AUTH_CODE_INVALID' },
    })
    expect(JSON.stringify(calls)).not.toContain(CODE)
    expect(calls[0]?.message).toContain('[redacted]')
  })

  it('reads a domain the supplier cannot find as not transferable', async () => {
    const { registrar } = setup(() => json(404, { error: { message: 'Domain not found' } }))
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toEqual({
      kind: 'ok',
      data: { transferable: false, reason: 'NOT_TRANSFERABLE' },
    })
  })

  it('never reads a timeout or refused credentials as an answer', async () => {
    await expect(
      setup(timeout).registrar.checkTransfer('getpaid.com', CODE),
    ).resolves.toMatchObject({ kind: 'unknown' })
    await expect(
      setup(() => json(401, {})).registrar.checkTransfer('getpaid.com', CODE),
    ).resolves.toMatchObject({ kind: 'blocked', code: 'SUPPLIER_AUTH' })
  })

  it('gives up waiting for a supplier slot, and says it does not know', async () => {
    const { registrar } = setup(
      () => json(200, { transferAvailabilityStatus: true }),
      new Semaphore(0),
      { waitMs: 5 },
    )
    await expect(registrar.checkTransfer('getpaid.com', CODE)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NO_EXCHANGE',
    })
  })
})

describe('transfer (FR-T2)', () => {
  const input = { domainName: 'getpaid.com', authCode: CODE, periodYears: 1, contact: CONTACT }

  it('sends the code, the period and the registrant in every role', async () => {
    const { registrar, sent, calls } = setup(() => json(200, { domainName: 'getpaid.com' }))
    await expect(registrar.transfer(input)).resolves.toEqual({ kind: 'ok' })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/domains/transfer',
      body: { domainName: 'getpaid.com', authCode: CODE, period: 1 },
    })
    expect(firstNameByRole(sent[0]?.body)).toEqual({
      Admin: 'Ada',
      Billing: 'Ada',
      Registrant: 'Ada',
      Tech: 'Ada',
    })
    expect(calls[0]).toMatchObject({ operation: 'Transfer', outcome: 'ok' })
    expect(JSON.stringify(calls)).not.toContain(CODE)
  })

  it('sends each role its own contact, the registrant where there is none (FR-A4)', async () => {
    const { registrar, sent } = setup(() => json(200, { domainName: 'getpaid.com' }))
    const tunde = { ...CONTACT, firstName: 'Tunde', email: 'tunde@example.com' }
    await registrar.transfer({ ...input, contacts: { administrative: tunde } })
    expect(firstNameByRole(sent[0]?.body)).toEqual({
      Admin: 'Tunde',
      Billing: 'Ada',
      Registrant: 'Ada',
      Tech: 'Ada',
    })
  })

  it.each([
    ['The auth code is incorrect', 'AUTH_CODE_INVALID'],
    ['Domain status clientTransferProhibited', 'TRANSFER_LOCKED'],
    ['Insufficient balance', 'SUPPLIER_INSUFFICIENT_FUNDS'],
    ['Domain was registered less than 60 days ago', 'NOT_TRANSFERABLE'],
  ])('classifies the refusal “%s” as %s', async (message, code) => {
    const { registrar } = setup(() => json(400, { error: { message } }))
    await expect(registrar.transfer(input)).resolves.toEqual({ kind: 'rejected', code, message })
  })

  it('keeps an echoed code out of the record and out of what it returns', async () => {
    const { registrar, calls } = setup(() =>
      json(400, { error: { message: `EPP code ${CODE.toLowerCase()} rejected by registry` } }),
    )
    const written = await registrar.transfer(input)
    expect(JSON.stringify(written).toLowerCase()).not.toContain(CODE.toLowerCase())
    expect(JSON.stringify(calls).toLowerCase()).not.toContain(CODE.toLowerCase())
  })

  it('reads a domain the supplier cannot find as a refusal', async () => {
    const { registrar } = setup(() => json(404, { error: { message: 'Domain not found' } }))
    await expect(registrar.transfer(input)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'NOT_TRANSFERABLE',
    })
  })

  it('never reads a timeout as failed — it may have been taken (N3)', async () => {
    await expect(setup(timeout).registrar.transfer(input)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'TIMEOUT',
    })
    await expect(setup(() => json(503, {})).registrar.transfer(input)).resolves.toMatchObject({
      kind: 'unknown',
    })
    await expect(setup(() => json(401, {})).registrar.transfer(input)).resolves.toMatchObject({
      kind: 'blocked',
    })
  })
})

describe('the registry’s status for a transfer', () => {
  it('reads the words the REST API sends as numbers', () => {
    expect(statusWord(3)).toBe('WaitingForIncomingTransfer')
    expect(statusWord('0')).toBe('Active')
    expect(statusWord('WaitingForIncomingTransfer')).toBe('WaitingForIncomingTransfer')
    expect(statusWord(99)).toBe('99')
    expect(statusWord(undefined)).toBe('')
  })

  it.each([
    ['Active', 'landed'],
    ['ok', 'landed'],
    ['WaitingForIncomingTransfer', 'waiting'],
    ['3', 'waiting'],
    ['pendingTransfer', 'waiting'],
    ['ConfirmationEmailSend', 'waiting'],
    ['TransferredOut', 'gone'],
    ['Deleted', 'gone'],
    ['TransferCancelled', 'gone'],
    ['Rejected', 'gone'],
    ['PendingDelete', 'unclear'],
    ['WaitingForOutgoingTransfer', 'unclear'],
    ['', 'unclear'],
  ])('%s → %s', (status, state) => {
    expect(transferState(status)).toBe(state)
  })

  it('reads a record with no status as unclear', () => {
    expect(transferState(undefined)).toBe('unclear')
  })
})

describe('classifyTransferRefusal', () => {
  it.each([
    ['Invalid authorization code', 'AUTH_CODE_INVALID'],
    ['EPP password mismatch', 'AUTH_CODE_INVALID'],
    ['Wrong transfer code', 'AUTH_CODE_INVALID'],
    ['Domain is locked', 'TRANSFER_LOCKED'],
    ['clientTransferProhibited', 'TRANSFER_LOCKED'],
    ['TransferLock is enabled', 'TRANSFER_LOCKED'],
    ['Request blocked by registry policy', 'NOT_TRANSFERABLE'],
    ['Something nobody expected', 'NOT_TRANSFERABLE'],
  ])('%s → %s', (message, reason) => {
    expect(classifyTransferRefusal(message)).toBe(reason)
  })
})

describe('redact', () => {
  it('removes every copy of the secret, whatever its case or characters', () => {
    expect(redact('code a.b*c(1) and A.B*C(1)', 'a.b*c(1)')).toBe('code [redacted] and [redacted]')
  })

  it('leaves text alone when there is no secret', () => {
    expect(redact('nothing to hide', undefined)).toBe('nothing to hide')
    expect(redact('nothing to hide', '')).toBe('nothing to hide')
  })
})
