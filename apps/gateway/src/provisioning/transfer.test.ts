import type { Contact } from '@dr/shared'
import { describe, expect, it, vi } from 'vitest'
import type {
  Lookup,
  RegistryDomain,
  TransferCheckAnswer,
  TransferRegistrar,
  TransferWrite,
} from './registrar'
import { NOT_LISTED_GRACE_MS, runTransfer, type TransferTask } from './transfer'

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

const NOW = new Date('2026-09-24T12:00:00.000Z')
const HOUR = 3_600_000

const inAccount = (status: string, over: Partial<RegistryDomain> = {}): Lookup => ({
  kind: 'found',
  domain: {
    registeredAt: '2019-03-01T10:00:00.000Z',
    expiresAt: '2027-03-01T10:00:00.000Z',
    nameservers: ['ns1.example-host.com', 'ns2.example-host.com'],
    transferLock: true,
    privacy: false,
    status,
    ...over,
  },
})
const ACTIVE = inAccount('Active')
const WAITING = inAccount('WaitingForIncomingTransfer')
const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const
const blocked = { kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' } as const

function registrar(script: {
  lookups?: Lookup[]
  check?: TransferCheckAnswer
  transfer?: TransferWrite
}) {
  const lookups = [...(script.lookups ?? [])]
  return {
    lookup: vi.fn(async (): Promise<Lookup> => lookups.shift() ?? { kind: 'not_found' }),
    checkTransfer: vi.fn(
      async (): Promise<TransferCheckAnswer> =>
        script.check ?? { kind: 'ok', data: { transferable: true } },
    ),
    transfer: vi.fn(async (): Promise<TransferWrite> => script.transfer ?? { kind: 'ok' }),
  } satisfies TransferRegistrar
}

const task = (over: Partial<TransferTask> = {}): TransferTask => ({
  domainName: 'getpaid.com',
  authCode: 'Xy7#code',
  periodYears: 1,
  contact: CONTACT,
  submittedAt: null,
  now: NOW,
  ...over,
})

describe('runTransfer — before the registry has the request', () => {
  it('fails a code the supplier refuses, and never sends the transfer', async () => {
    const reg = registrar({
      check: { kind: 'ok', data: { transferable: false, reason: 'AUTH_CODE_INVALID' } },
    })
    await expect(runTransfer(reg, task())).resolves.toEqual({
      kind: 'rejected',
      code: 'AUTH_CODE_INVALID',
      message: expect.any(String),
    })
    expect(reg.checkTransfer).toHaveBeenCalledWith('getpaid.com', 'Xy7#code')
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('fails a line whose code is gone, before asking the supplier anything', async () => {
    const reg = registrar({})
    await expect(runTransfer(reg, task({ authCode: null }))).resolves.toMatchObject({
      kind: 'rejected',
      code: 'AUTH_CODE_MISSING',
    })
    expect(reg.checkTransfer).not.toHaveBeenCalled()
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('holds a job with no registrant to send rather than refunding it', async () => {
    const reg = registrar({})
    await expect(runTransfer(reg, task({ contact: null }))).resolves.toMatchObject({
      kind: 'unknown',
      code: 'BAD_JOB',
    })
    expect(reg.checkTransfer).not.toHaveBeenCalled()
  })

  it('sends nothing when the first read gets no answer (I1)', async () => {
    for (const lookup of [timedOut, blocked]) {
      const reg = registrar({ lookups: [lookup] })
      await expect(runTransfer(reg, task())).resolves.toMatchObject({ kind: lookup.kind })
      expect(reg.checkTransfer).not.toHaveBeenCalled()
    }
  })

  it('finishes without sending when an earlier attempt already landed', async () => {
    const reg = registrar({ lookups: [ACTIVE] })
    await expect(runTransfer(reg, task())).resolves.toMatchObject({
      kind: 'transferred',
      recovered: true,
      domain: { expiresAt: '2027-03-01T10:00:00.000Z', status: 'Active' },
    })
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('counts an earlier attempt the registry is already waiting on as sent', async () => {
    const reg = registrar({ lookups: [WAITING] })
    await expect(runTransfer(reg, task())).resolves.toEqual({ kind: 'submitted' })
    expect(reg.checkTransfer).not.toHaveBeenCalled()
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('never guesses at a status it does not know, or an active domain with no expiry', async () => {
    for (const lookup of [inAccount('PendingHold'), inAccount('Active', { expiresAt: null })]) {
      const reg = registrar({ lookups: [lookup] })
      await expect(runTransfer(reg, task())).resolves.toMatchObject({ kind: 'unknown' })
      expect(reg.transfer).not.toHaveBeenCalled()
    }
  })

  it('treats a record that left our account as nothing there', async () => {
    const reg = registrar({ lookups: [inAccount('TransferredOut')] })
    await expect(runTransfer(reg, task())).resolves.toEqual({ kind: 'submitted' })
    expect(reg.transfer).toHaveBeenCalled()
  })

  it('waits when the check cannot be made', async () => {
    for (const check of [timedOut, blocked]) {
      const reg = registrar({ check })
      await expect(runTransfer(reg, task())).resolves.toMatchObject({ kind: check.kind })
      expect(reg.transfer).not.toHaveBeenCalled()
    }
  })

  it('sends the transfer with the code, the years and the registrant', async () => {
    const reg = registrar({})
    await expect(runTransfer(reg, task({ periodYears: 1 }))).resolves.toEqual({
      kind: 'submitted',
    })
    expect(reg.transfer).toHaveBeenCalledWith({
      domainName: 'getpaid.com',
      authCode: 'Xy7#code',
      periodYears: 1,
      contact: CONTACT,
    })
  })

  it('fails a transfer the registry refuses, with its reason', async () => {
    const reg = registrar({
      transfer: { kind: 'rejected', code: 'TRANSFER_LOCKED', message: 'Domain is locked' },
    })
    await expect(runTransfer(reg, task())).resolves.toEqual({
      kind: 'rejected',
      code: 'TRANSFER_LOCKED',
      message: 'Domain is locked',
    })
  })

  it('passes on refused credentials without reading', async () => {
    const reg = registrar({ transfer: blocked })
    await expect(runTransfer(reg, task())).resolves.toMatchObject({ kind: 'blocked' })
    expect(reg.lookup).toHaveBeenCalledTimes(1)
  })

  describe('a transfer with no answer is settled by reading, never by sending again (N3)', () => {
    it('is sent if the registry now waits on it, or already has it', async () => {
      for (const after of [WAITING, ACTIVE]) {
        const reg = registrar({ lookups: [{ kind: 'not_found' }, after], transfer: timedOut })
        await expect(runTransfer(reg, task())).resolves.toEqual({ kind: 'submitted' })
        expect(reg.transfer).toHaveBeenCalledTimes(1)
      }
    })

    it('is known not sent when the registry has nothing — safe to try later', async () => {
      for (const after of [{ kind: 'not_found' } as const, inAccount('TransferredOut')]) {
        const reg = registrar({ lookups: [{ kind: 'not_found' }, after], transfer: timedOut })
        await expect(runTransfer(reg, task())).resolves.toEqual({
          kind: 'not_submitted',
          code: 'TIMEOUT',
          message: 'No answer',
        })
      }
    })

    it('stays unknown when the read cannot be made either', async () => {
      const reg = registrar({ lookups: [{ kind: 'not_found' }, timedOut], transfer: timedOut })
      await expect(runTransfer(reg, task())).resolves.toEqual({
        kind: 'unknown',
        code: 'TIMEOUT',
        message: 'No answer',
      })
    })
  })
})

describe('runTransfer — polling after the request', () => {
  const since = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString()
  const polled = (over: Partial<TransferTask> = {}) =>
    task({ authCode: null, submittedAt: since(2), ...over })

  it('records the transfer once the domain is active in our account', async () => {
    const reg = registrar({ lookups: [ACTIVE] })
    await expect(runTransfer(reg, polled())).resolves.toMatchObject({
      kind: 'transferred',
      recovered: false,
      domain: { expiresAt: '2027-03-01T10:00:00.000Z' },
    })
    expect(reg.checkTransfer).not.toHaveBeenCalled()
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('keeps waiting while the current registrar has not answered', async () => {
    const reg = registrar({ lookups: [WAITING] })
    await expect(runTransfer(reg, polled())).resolves.toEqual({ kind: 'waiting' })
  })

  it('fails a transfer the registry shows cancelled or refused', async () => {
    for (const status of ['TransferCancelled', 'Rejected', 'Deleted']) {
      const reg = registrar({ lookups: [inAccount(status)] })
      await expect(runTransfer(reg, polled())).resolves.toMatchObject({
        kind: 'rejected',
        code: 'TRANSFER_REJECTED',
      })
    }
  })

  it('reads nothing there as lag for a day, then as refused', async () => {
    const early = registrar({ lookups: [{ kind: 'not_found' }] })
    await expect(runTransfer(early, polled({ submittedAt: since(23) }))).resolves.toEqual({
      kind: 'waiting',
    })
    const late = registrar({ lookups: [{ kind: 'not_found' }] })
    await expect(
      runTransfer(
        late,
        polled({ submittedAt: new Date(NOW.getTime() - NOT_LISTED_GRACE_MS).toISOString() }),
      ),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'TRANSFER_REJECTED' })
  })

  it('never decides on a read it could not make', async () => {
    const reg = registrar({ lookups: [timedOut] })
    await expect(runTransfer(reg, polled())).resolves.toEqual(timedOut)
  })
})
