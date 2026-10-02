import { describe, expect, it, vi } from 'vitest'
import type { SslClient, SslReading, SslStatusAnswer, SslWrite } from './client'
import { runSslConfigure, runSslInitialize, runSslReissue } from './jobs'

/**
 * The SSL sagas (FR-SSL-3, -4, -8): read first, note the send, and after an
 * unknown answer read — never send again (N3). A scripted client stands in
 * for the supplier; each answer is queued per call.
 */

const status = (
  word: string,
  configured = word !== 'WaitingForInstall',
): SslReading<SslStatusAnswer> => ({
  kind: 'found',
  data: {
    domainName: 'example.com',
    status: word,
    isConfigured: configured,
    isIssued: word === 'Active',
    certificateExpiresAt: null,
  },
})
const NOT_FOUND = { kind: 'not_found' } as const
const TIMEOUT = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

function scripted(answers: Partial<Record<keyof SslClient, unknown[]>>) {
  const queues = Object.fromEntries(
    Object.entries(answers).map(([key, list]) => [key, [...(list ?? [])]]),
  ) as Record<string, unknown[]>
  const next = (method: string) =>
    vi.fn(async () => {
      const queue = queues[method]
      if (!queue || queue.length === 0) throw new Error(`${method} was not expected`)
      return queue.shift()
    })
  const client = {
    status: next('status'),
    details: next('details'),
    content: next('content'),
    approvers: next('approvers'),
    checkCsr: next('checkCsr'),
    generateCsr: next('generateCsr'),
    initialize: next('initialize'),
    configure: next('configure'),
    reissue: next('reissue'),
  }
  return client as unknown as SslClient & Record<keyof SslClient, ReturnType<typeof vi.fn>>
}

const DETAILS = {
  kind: 'found',
  data: {
    status: 'WaitingForInstall',
    packageCode: '351',
    isConfigured: false,
    isIssued: false,
    purchasedAt: '2026-10-02T11:45:37.456Z',
    subscriptionEndsAt: '2027-10-02T11:45:37.456Z',
    issuedAt: null,
    validUntil: null,
  },
} as const

const BOUGHT: SslWrite<{ certificateId: string | null; status: string }> = {
  kind: 'ok',
  data: { certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0', status: 'WaitingForInstall' },
}

const order = (over: Partial<Parameters<typeof runSslInitialize>[1]> = {}) => ({
  name: 'example.com',
  productCode: '351',
  isWildcard: false,
  nameTaken: false,
  sentAt: null,
  noteSent: vi.fn(async () => '2026-10-02T12:00:00Z'),
  ...over,
})

describe('ordering a certificate (FR-SSL-3)', () => {
  it('reads first, notes the send, buys, and reads the subscription back', async () => {
    const client = scripted({ status: [NOT_FOUND], initialize: [BOUGHT], details: [DETAILS] })
    const noteSent = vi.fn(async () => '2026-10-02T12:00:00Z')
    const outcome = await runSslInitialize(client, order({ noteSent }))
    expect(outcome).toEqual({
      kind: 'bought',
      recovered: false,
      certificate: {
        certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0',
        supplierStatus: 'WaitingForInstall',
        purchasedAt: '2026-10-02T11:45:37.456Z',
        subscriptionEndsAt: '2027-10-02T11:45:37.456Z',
      },
    })
    expect(noteSent).toHaveBeenCalledTimes(1)
    expect(noteSent.mock.invocationCallOrder[0]).toBeLessThan(
      client.initialize.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('buys a wildcard by its *. name and does not ask for the details it cannot read', async () => {
    const client = scripted({ status: [NOT_FOUND], initialize: [BOUGHT] })
    const outcome = await runSslInitialize(
      client,
      order({ name: '*.example.com', productCode: '352', isWildcard: true }),
    )
    expect(client.initialize).toHaveBeenCalledWith('352', '*.example.com')
    expect(client.details).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'bought', certificate: { purchasedAt: null } })
  })

  it('refuses a name another certificate here holds, before reading or buying', async () => {
    const client = scripted({})
    const task = order({ nameTaken: true })
    await expect(runSslInitialize(client, task)).resolves.toMatchObject({
      kind: 'refused',
      code: 'NAME_HAS_CERTIFICATE',
    })
    expect(task.noteSent).not.toHaveBeenCalled()
  })

  it('refuses a name the supplier already holds, when it never sent: nothing was bought', async () => {
    const client = scripted({ status: [status('Active')] })
    await expect(runSslInitialize(client, order())).resolves.toMatchObject({
      kind: 'refused',
      code: 'NAME_HAS_CERTIFICATE',
    })
    expect(client.initialize).not.toHaveBeenCalled()
  })

  it('passes a supplier refusal on: the line is refunded', async () => {
    const client = scripted({
      status: [NOT_FOUND],
      initialize: [{ kind: 'rejected', code: 'SUPPLIER_INSUFFICIENT_FUNDS', message: 'Balance' }],
    })
    await expect(runSslInitialize(client, order())).resolves.toEqual({
      kind: 'refused',
      code: 'SUPPLIER_INSUFFICIENT_FUNDS',
      message: 'Balance',
    })
  })

  it('settles a timeout by reading: found, it is ours and bought once', async () => {
    const client = scripted({
      status: [NOT_FOUND, status('WaitingForInstall')],
      initialize: [TIMEOUT],
      details: [DETAILS, DETAILS],
    })
    await expect(runSslInitialize(client, order())).resolves.toMatchObject({
      kind: 'bought',
      recovered: true,
    })
    expect(client.initialize).toHaveBeenCalledTimes(1)
  })

  it('settles a timeout by reading: not there, it stays unknown — never bought again', async () => {
    const client = scripted({ status: [NOT_FOUND, NOT_FOUND], initialize: [TIMEOUT] })
    await expect(runSslInitialize(client, order())).resolves.toEqual(TIMEOUT)
    expect(client.initialize).toHaveBeenCalledTimes(1)
  })

  it('after a noted send, only ever reads (N3)', async () => {
    const notThere = scripted({ status: [NOT_FOUND] })
    const sent = order({ sentAt: '2026-10-02T12:00:00Z' })
    await expect(runSslInitialize(notThere, sent)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
    expect(notThere.initialize).not.toHaveBeenCalled()
    expect(sent.noteSent).not.toHaveBeenCalled()

    const there = scripted({ status: [status('WaitingForInstall')], details: [DETAILS, DETAILS] })
    await expect(runSslInitialize(there, sent)).resolves.toMatchObject({
      kind: 'bought',
      recovered: true,
    })
    expect(there.initialize).not.toHaveBeenCalled()
  })

  it('holds for a person when the certificate found is not the product bought', async () => {
    const client = scripted({
      status: [status('WaitingForInstall')],
      details: [{ ...DETAILS, data: { ...DETAILS.data, packageCode: '371' } }],
    })
    await expect(runSslInitialize(client, order({ sentAt: 'x' }))).resolves.toMatchObject({
      kind: 'held',
      code: 'NAME_HAS_OTHER_CERTIFICATE',
    })
  })

  it('holds for a person when a name was taken after this one sent', async () => {
    await expect(
      runSslInitialize(scripted({}), order({ nameTaken: true, sentAt: 'x' })),
    ).resolves.toMatchObject({
      kind: 'held',
      code: 'NAME_TAKEN_AFTER_SEND',
    })
  })

  it('does nothing on an unreadable supplier', async () => {
    const blocked = { kind: 'blocked', code: 'SUPPLIER_IP_BLOCKED', message: 'IP' } as const
    const client = scripted({ status: [blocked] })
    await expect(runSslInitialize(client, order())).resolves.toEqual(blocked)
    expect(client.initialize).not.toHaveBeenCalled()
  })

  it('keeps the answer when the details cannot be read back', async () => {
    const client = scripted({ status: [NOT_FOUND], initialize: [BOUGHT], details: [TIMEOUT] })
    await expect(runSslInitialize(client, order())).resolves.toMatchObject({
      kind: 'bought',
      certificate: {
        certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0',
        supplierStatus: 'WaitingForInstall',
        purchasedAt: null,
      },
    })
  })
})

const setUp = (over: Partial<Parameters<typeof runSslConfigure>[1]> = {}) => ({
  name: 'example.com',
  csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIC\n-----END CERTIFICATE REQUEST-----',
  approverEmail: 'admin@example.com',
  webServer: 'apache' as const,
  extraNames: [],
  contact: {} as never,
  sentAt: null,
  noteSent: vi.fn(async () => 'now'),
  ...over,
})

describe('setting a certificate up (FR-SSL-4)', () => {
  it('sends the set-up to a certificate waiting for one', async () => {
    const client = scripted({
      status: [status('WaitingForInstall')],
      configure: [{ kind: 'ok', data: { status: 'WaitingForValidation' } }],
    })
    await expect(runSslConfigure(client, setUp())).resolves.toEqual({
      kind: 'configured',
      recovered: false,
      supplierStatus: 'WaitingForValidation',
    })
  })

  it('gives a refusal back to the customer with our code', async () => {
    const client = scripted({
      status: [status('WaitingForInstall')],
      configure: [{ kind: 'rejected', code: 'CSR_NAME_MISMATCH', message: 'mismatch' }],
    })
    await expect(runSslConfigure(client, setUp())).resolves.toMatchObject({
      kind: 'refused',
      code: 'CSR_NAME_MISMATCH',
    })
  })

  it('settles an unknown answer by reading, and sends again only after a read shows nothing landed', async () => {
    const landed = scripted({
      status: [status('WaitingForInstall'), status('WaitingForValidation')],
      configure: [TIMEOUT],
    })
    await expect(runSslConfigure(landed, setUp())).resolves.toMatchObject({
      kind: 'configured',
      recovered: true,
    })

    const notLanded = scripted({
      status: [status('WaitingForInstall'), status('WaitingForInstall')],
      configure: [TIMEOUT],
    })
    await expect(runSslConfigure(notLanded, setUp())).resolves.toEqual(TIMEOUT)
  })

  it('records a set-up an earlier attempt already made', async () => {
    const client = scripted({ status: [status('WaitingForValidation')] })
    await expect(runSslConfigure(client, setUp({ sentAt: 'x' }))).resolves.toMatchObject({
      kind: 'configured',
      recovered: true,
    })
    expect(client.configure).not.toHaveBeenCalled()
  })

  it('holds a set-up it finds made but never sent', async () => {
    const client = scripted({ status: [status('Active')] })
    await expect(runSslConfigure(client, setUp())).resolves.toMatchObject({
      kind: 'held',
      code: 'ALREADY_CONFIGURED',
    })
  })

  it('cannot set up what the supplier cannot find, or cannot be read', async () => {
    await expect(
      runSslConfigure(scripted({ status: [NOT_FOUND] }), setUp()),
    ).resolves.toMatchObject({
      kind: 'unknown',
      code: 'CERTIFICATE_NOT_FOUND',
    })
    await expect(runSslConfigure(scripted({ status: [TIMEOUT] }), setUp())).resolves.toEqual(
      TIMEOUT,
    )
  })
})

const again = (over: Partial<Parameters<typeof runSslReissue>[1]> = {}) => ({
  name: 'example.com',
  approverEmail: 'admin@example.com',
  sentAt: null,
  noteSent: vi.fn(async () => 'now'),
  ...over,
})

describe('reissuing a certificate (FR-SSL-8)', () => {
  it('reissues an issued certificate and says where it now stands', async () => {
    const client = scripted({
      status: [status('Active'), status('WaitingForValidation')],
      reissue: [{ kind: 'ok', data: { status: 'WaitingForValidation' } }],
    })
    await expect(runSslReissue(client, again())).resolves.toEqual({
      kind: 'reissued',
      recovered: false,
      supplierStatus: 'WaitingForValidation',
      state: 'awaiting_validation',
    })
  })

  it('may ask for a new request: the certificate goes back to set-up', async () => {
    const client = scripted({
      status: [status('Active'), status('WaitingForInstall')],
      reissue: [{ kind: 'ok', data: { status: '' } }],
    })
    await expect(runSslReissue(client, again())).resolves.toMatchObject({ state: 'awaiting_setup' })
  })

  it('refuses to reissue what is not issued, and passes a refusal on', async () => {
    await expect(
      runSslReissue(scripted({ status: [status('WaitingForValidation')] }), again()),
    ).resolves.toMatchObject({
      kind: 'refused',
      code: 'SSL_WRONG_STATE',
    })
    const refused = scripted({
      status: [status('Active')],
      reissue: [{ kind: 'rejected', code: 'NOT_SUPPORTED', message: 'Package is not supported' }],
    })
    await expect(runSslReissue(refused, again())).resolves.toMatchObject({
      kind: 'refused',
      code: 'NOT_SUPPORTED',
    })
  })

  it('after an unknown answer reads, and never sends again', async () => {
    const changed = scripted({
      status: [status('Active'), status('WaitingForValidation')],
      reissue: [TIMEOUT],
    })
    await expect(runSslReissue(changed, again())).resolves.toMatchObject({
      kind: 'reissued',
      recovered: true,
    })

    const unchanged = scripted({ status: [status('Active'), status('Active')], reissue: [TIMEOUT] })
    await expect(runSslReissue(unchanged, again())).resolves.toEqual(TIMEOUT)

    const sentBefore = scripted({ status: [status('Active')] })
    await expect(runSslReissue(sentBefore, again({ sentAt: 'x' }))).resolves.toMatchObject({
      kind: 'unknown',
      code: 'REISSUE_UNCONFIRMED',
    })
    expect(sentBefore.reissue).not.toHaveBeenCalled()

    const tookIt = scripted({ status: [status('WaitingForInstall')] })
    await expect(runSslReissue(tookIt, again({ sentAt: 'x' }))).resolves.toMatchObject({
      kind: 'reissued',
      recovered: true,
      state: 'awaiting_setup',
    })
  })

  it('cannot reissue what the supplier cannot find, or read', async () => {
    await expect(runSslReissue(scripted({ status: [NOT_FOUND] }), again())).resolves.toMatchObject({
      code: 'CERTIFICATE_NOT_FOUND',
    })
    await expect(runSslReissue(scripted({ status: [TIMEOUT] }), again())).resolves.toEqual(TIMEOUT)
  })

  it('says so when a taken reissue cannot be read back', async () => {
    const client = scripted({
      status: [status('Active'), TIMEOUT],
      reissue: [{ kind: 'ok', data: { status: '' } }],
    })
    await expect(runSslReissue(client, again())).resolves.toMatchObject({
      code: 'REISSUE_UNREADABLE',
    })
  })
})
