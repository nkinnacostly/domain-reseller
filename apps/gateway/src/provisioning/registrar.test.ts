import type { Contact } from '@dr/shared'
import DomainNameApi from 'nodejs-dna'
import { describe, expect, it } from 'vitest'
import { createTransport } from '../dna/transport'
import { Semaphore } from '../lib/semaphore'
import {
  type CallRecord,
  classifyRefusal,
  createDnaRegistrar,
  judgeExchange,
  supplierDate,
  toDnaContact,
} from './registrar'

/**
 * The real SDK over a fake network: these tests pin down what the SDK sends
 * and what we make of every kind of answer — including the ones the SDK
 * itself gets wrong (a timeout it reports as a successful nameserver change).
 */

type Route = (method: string, path: string, body: unknown) => Response | Promise<Response>

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const timeout = () => {
  throw new DOMException('The operation timed out.', 'TimeoutError')
}

const DOMAIN_INFO = {
  id: 7,
  status: 0,
  domainName: 'example.com',
  startDate: '2026-09-23T10:00:00Z',
  expirationDate: '2027-09-23T10:00:00Z',
  lockStatus: true,
  privacyProtectionStatus: false,
  nameservers: ['NS1.domainnameapi.com', 'ns2.domainnameapi.com'],
  contacts: [],
}

const NOT_FOUND = {
  error: {
    code: 'Dna.DomainService:Domain:10007',
    message: 'The domain name you requested could not be found. Please check and try again.',
    details: 'The domain could not be found. Please check and try again.',
    validationErrors: null,
  },
}

function setup(route: Route) {
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
    slots: new Semaphore(2),
  })
  return { registrar, calls, sent }
}

describe('lookup', () => {
  it('reads a 404 as not registered to us', async () => {
    const { registrar } = setup(() => json(404, NOT_FOUND))
    await expect(registrar.lookup('example.com')).resolves.toEqual({ kind: 'not_found' })
  })

  it('reads the domain, with exact dates and lower-case nameservers', async () => {
    const { registrar } = setup(() => json(200, DOMAIN_INFO))
    await expect(registrar.lookup('example.com')).resolves.toEqual({
      kind: 'found',
      domain: {
        registeredAt: '2026-09-23T10:00:00.000Z',
        expiresAt: '2027-09-23T10:00:00.000Z',
        nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
        transferLock: true,
        privacy: false,
      },
    })
  })

  it('never reads a timeout as "not registered"', async () => {
    const { registrar } = setup(timeout)
    await expect(registrar.lookup('example.com')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'TIMEOUT',
    })
  })

  it('reads a server error as unknown', async () => {
    const { registrar } = setup(() => json(503, {}))
    await expect(registrar.lookup('example.com')).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('reports refused credentials as blocked, for operations', async () => {
    const { registrar } = setup(() => json(401, {}))
    await expect(registrar.lookup('example.com')).resolves.toMatchObject({
      kind: 'blocked',
      code: 'SUPPLIER_AUTH',
    })
  })
})

describe('register', () => {
  it('registers on the supplier’s default nameservers, locked, with privacy as bought', async () => {
    const { registrar, sent } = setup(() => json(200, DOMAIN_INFO))
    await registrar.register({
      domainName: 'example.com',
      periodYears: 2,
      contact: CONTACT,
      privacy: true,
    })

    const call = sent.find((request) => request.path.endsWith('/domains/register-with-contacts'))
    expect(call?.method).toBe('POST')
    expect(call?.body).toMatchObject({
      domainName: 'example.com',
      period: 2,
      isLocked: true,
      privacyEnabled: true,
      nameServers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
    })
    const body = call?.body as { contacts?: unknown[] } | undefined
    expect(body?.contacts).toHaveLength(4)
  })

  it('returns what the registry recorded', async () => {
    const { registrar } = setup(() => json(200, DOMAIN_INFO))
    const result = await registrar.register({
      domainName: 'example.com',
      periodYears: 1,
      contact: CONTACT,
      privacy: false,
    })
    expect(result).toMatchObject({
      kind: 'ok',
      data: { expiresAt: '2027-09-23T10:00:00.000Z', transferLock: true },
    })
  })

  it('classifies a refusal from the supplier’s own message', async () => {
    const { registrar } = setup(() =>
      json(400, { error: { code: 'Dna.Reseller:1', message: 'Insufficient balance' } }),
    )
    await expect(
      registrar.register({ domainName: 'a.com', periodYears: 1, contact: CONTACT, privacy: false }),
    ).resolves.toEqual({
      kind: 'rejected',
      code: 'SUPPLIER_INSUFFICIENT_FUNDS',
      message: 'Insufficient balance',
    })
  })

  it('never reads a timeout as failed — it may have landed', async () => {
    const { registrar } = setup(timeout)
    await expect(
      registrar.register({ domainName: 'a.com', periodYears: 1, contact: CONTACT, privacy: false }),
    ).resolves.toMatchObject({ kind: 'unknown', code: 'TIMEOUT' })
  })

  it('treats an accepted but unreadable answer as unknown, not success', async () => {
    const { registrar } = setup(() => json(200, {}))
    await expect(
      registrar.register({ domainName: 'a.com', periodYears: 1, contact: CONTACT, privacy: false }),
    ).resolves.toMatchObject({ kind: 'unknown', code: 'UNPARSEABLE' })
  })
})

describe('renew', () => {
  it('asks for the years paid for, and reports the new expiry on the supplier’s clock', async () => {
    const { registrar, sent } = setup(() => json(200, { expirationDate: '2028-09-23T10:00:00' }))
    await expect(registrar.renew('example.com', 1)).resolves.toEqual({
      kind: 'ok',
      data: { expiresAt: '2028-09-23T07:00:00.000Z' },
    })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: expect.stringMatching(/domains\/renew$/),
      body: { domainName: 'example.com', period: 1 },
    })
  })

  it('never reads a timeout as failed — it may have landed', async () => {
    const { registrar } = setup(timeout)
    await expect(registrar.renew('example.com', 1)).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('reads a domain not in our account as a refusal', async () => {
    const { registrar } = setup(() => json(404, NOT_FOUND))
    await expect(registrar.renew('example.com', 1)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
    })
  })

  it('classifies a refusal from the supplier’s own message', async () => {
    const { registrar } = setup(() =>
      json(400, { error: { message: 'Domain can not be renewed for the given period' } }),
    )
    await expect(registrar.renew('example.com', 9)).resolves.toMatchObject({ kind: 'rejected' })
  })

  it('reports refused credentials as blocked, for operations', async () => {
    const { registrar } = setup(() => json(401, {}))
    await expect(registrar.renew('example.com', 1)).resolves.toMatchObject({ kind: 'blocked' })
  })
})

describe('setNameservers', () => {
  it('applies the set', async () => {
    const { registrar, sent } = setup(() =>
      json(200, { nameServers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] }),
    )
    await expect(
      registrar.setNameservers('example.com', ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']),
    ).resolves.toEqual({ kind: 'ok', data: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] })
    expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/v1/domains/dns/name-server' })
  })

  it('reports a timeout as unknown, where the SDK alone reports success', async () => {
    const { registrar } = setup(timeout)
    await expect(
      registrar.setNameservers('example.com', ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']),
    ).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('classifies a refused nameserver', async () => {
    const { registrar } = setup(() =>
      json(400, { error: { message: 'Name server ns9.typo.test is not valid' } }),
    )
    await expect(
      registrar.setNameservers('example.com', ['ns9.typo.test', 'ns2.typo.test']),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'NAMESERVER_INVALID' })
  })
})

describe('audit (I7)', () => {
  it('records every call, with its outcome, before the caller sees it', async () => {
    const { registrar, calls } = setup((_method, path) =>
      path.endsWith('/domains/info') ? json(404, NOT_FOUND) : json(200, DOMAIN_INFO),
    )
    await registrar.lookup('example.com')
    await registrar.register({
      domainName: 'example.com',
      periodYears: 1,
      contact: CONTACT,
      privacy: false,
    })

    expect(calls).toEqual([
      expect.objectContaining({ operation: 'GetDetails', outcome: 'not_found', httpStatus: 404 }),
      expect.objectContaining({
        operation: 'RegisterWithContactInfo',
        outcome: 'ok',
        httpStatus: 200,
      }),
    ])
  })

  it('records no contact details', async () => {
    const { registrar, calls } = setup(() => json(400, { error: { message: 'Invalid phone' } }))
    await registrar.register({
      domainName: 'example.com',
      periodYears: 1,
      contact: CONTACT,
      privacy: false,
    })
    expect(JSON.stringify(calls)).not.toContain(CONTACT.email)
    expect(JSON.stringify(calls)).not.toContain(CONTACT.phone)
  })

  it('stops the job when the call cannot be recorded', async () => {
    const client = new DomainNameApi('00000000-0000-0000-0000-000000000000', 'key', {
      testMode: true,
      telemetry: false,
    })
    client.client._axios = createTransport((async () => json(200, DOMAIN_INFO)) as typeof fetch)
    const registrar = createDnaRegistrar({
      client,
      environment: 'ote',
      audit: async () => {
        throw new Error('database unavailable')
      },
      slots: new Semaphore(2),
    })
    await expect(registrar.lookup('example.com')).rejects.toThrow('database unavailable')
  })
})

/**
 * Contract: the sandbox's GetDetails record for a domain registered on
 * 23 Sept 2026 at 08:44 UTC, contacts removed.
 */
const SANDBOX_RECORD = {
  domainName: 'e2ecartsandboxmuduw599.com',
  startDate: '2026-09-23T11:44:10.0584644',
  expirationDate: '2027-09-23T11:44:10.0584644',
  transferDate: '0001-01-01T00:00:00',
  renewalMode: 'AutoRenew',
  lockStatus: true,
  privacyProtectionStatus: true,
  remainingDay: 365,
  statusCode: 'clientTransferProhibited',
  status: 'Active',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  hosts: [],
  contacts: [],
  additionalAttributes: {},
}

describe('the sandbox’s real answers', () => {
  it('reads a registered domain’s record', async () => {
    const { registrar } = setup(() => json(200, SANDBOX_RECORD))
    await expect(registrar.lookup(SANDBOX_RECORD.domainName)).resolves.toEqual({
      kind: 'found',
      domain: {
        registeredAt: '2026-09-23T08:44:10.058Z',
        expiresAt: '2027-09-23T08:44:10.058Z',
        nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
        transferLock: true,
        privacy: true,
      },
    })
  })

  it('reads a registry refusal sent as 403 as refused nameservers, not a blocked address', async () => {
    const { registrar } = setup(() =>
      json(403, {
        error: {
          message: 'An error occurred in the EPP integration.',
          details:
            "Failed to modify name server. The registry reported the issue as: 'Object association prohibits operation. Reason: 'NS1.VERCEL-DNS.COM' ns not found'",
        },
      }),
    )
    await expect(
      registrar.setNameservers(SANDBOX_RECORD.domainName, [
        'ns1.vercel-dns.com',
        'ns2.vercel-dns.com',
      ]),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'NAMESERVER_INVALID' })
  })
})

describe('judgeExchange', () => {
  const exchange = (status: number | null, body: unknown = {}) => ({
    method: 'POST',
    path: '/x',
    status,
    networkError: status === null ? 'ECONNRESET' : null,
    body,
    ms: 1,
  })

  it.each([408, 425, 429, 500, 502, 504])('reads HTTP %i as unknown', (status) => {
    expect(judgeExchange(exchange(status)).outcome).toBe('unknown')
  })

  it('reads a dropped connection as unknown', () => {
    expect(judgeExchange(exchange(null))).toMatchObject({ outcome: 'unknown', code: 'ECONNRESET' })
  })

  it('reads nothing sent as unknown', () => {
    expect(judgeExchange(undefined).outcome).toBe('unknown')
  })

  it('reads a bare 403, or one about our address, as an operations problem', () => {
    expect(judgeExchange(exchange(403))).toMatchObject({
      outcome: 'blocked',
      code: 'SUPPLIER_IP_BLOCKED',
    })
    expect(
      judgeExchange(exchange(403, { error: { message: 'Your IP address is not allowed' } })),
    ).toMatchObject({ outcome: 'blocked' })
  })
})

describe('classifyRefusal (PRD §13.8)', () => {
  it.each([
    ['Insufficient balance for this operation', 'SUPPLIER_INSUFFICIENT_FUNDS'],
    ['This TLD is not supported', 'TLD_UNSUPPORTED'],
    ['Name server ns1.x.test could not be resolved', 'NAMESERVER_INVALID'],
    ['Phone number is invalid', 'CONTACT_INVALID'],
    ['Domain exists', 'DOMAIN_TAKEN'],
    ['The domain name is not available', 'DOMAIN_TAKEN'],
    ['Something nobody expected', 'REGISTRATION_FAILED'],
  ])('%s → %s', (message, code) => {
    expect(classifyRefusal(message)).toBe(code)
  })
})

describe('supplierDate', () => {
  it('keeps an explicit zone', () => {
    expect(supplierDate('2026-09-23T10:00:00+01:00')).toBe('2026-09-23T09:00:00.000Z')
  })

  it('reads a zoneless date on the supplier’s clock, UTC+3, wherever the gateway runs', () => {
    expect(supplierDate('2026-09-23T11:44:10.0584644')).toBe('2026-09-23T08:44:10.058Z')
  })

  it('falls back to the SDK’s value, then to nothing', () => {
    expect(supplierDate(undefined, '2027-01-01T03:00:00')).toBe('2027-01-01T00:00:00.000Z')
    expect(supplierDate('', 'not a date')).toBeNull()
  })
})

describe('toDnaContact', () => {
  it('maps our contact to the supplier’s ContactInfo', () => {
    expect(toDnaContact(CONTACT)).toMatchObject({
      FirstName: 'Ada',
      EMail: 'ada@example.com',
      Phone: '8031234567',
      PhoneCountryCode: '234',
      Country: 'NG',
      Company: '',
    })
  })
})

describe('listPage (PRD §13.5)', () => {
  it('reads the portfolio from the raw body, where the SDK loses the nameservers', async () => {
    const { registrar, calls, sent } = setup(() =>
      json(200, { totalCount: 1, items: [{ ...SANDBOX_RECORD, status: 0 }] }),
    )
    await expect(registrar.listPage(0, 100)).resolves.toEqual({
      kind: 'ok',
      data: {
        total: 1,
        items: [
          {
            domainName: SANDBOX_RECORD.domainName,
            status: 'Active',
            expiresAt: '2027-09-23T08:44:10.058Z',
            nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
            transferLock: true,
            privacy: true,
            renewalMode: 'AutoRenew',
          },
        ],
      },
    })
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/api/v1/domains' })
    expect(calls[0]).toMatchObject({ operation: 'GetList', domainName: null, outcome: 'ok' })
  })

  it('reads a page it cannot understand as unknown', async () => {
    const { registrar } = setup(() => json(200, {}))
    await expect(registrar.listPage(0, 100)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'UNPARSEABLE',
    })
  })

  it('reads a timeout as unknown', async () => {
    const { registrar } = setup(timeout)
    await expect(registrar.listPage(0, 100)).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('skips rows without a name', async () => {
    const { registrar } = setup(() => json(200, { totalCount: 2, items: [{}, SANDBOX_RECORD] }))
    const page = await registrar.listPage(0, 100)
    expect(page.kind === 'ok' && page.data.items.map((item) => item.domainName)).toEqual([
      SANDBOX_RECORD.domainName,
    ])
  })
})
