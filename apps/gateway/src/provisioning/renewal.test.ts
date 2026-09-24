import { describe, expect, it, vi } from 'vitest'
import type { Lookup, Registrar, RegistryDomain, Write } from './registrar'
import { addYears, type RenewalTask, renewedSince, runRenewal } from './renewal'

/**
 * Every path a renewal can take. What matters in each: whether Renew is
 * called, and whether the outcome is decided by the registry's expiry — never
 * by trusting an answer, and never by renewing again blind (I2).
 */

const BASE: RegistryDomain = {
  registeredAt: '2025-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: [],
  transferLock: true,
  privacy: false,
}
const at = (expiresAt: string | null): Lookup => ({ kind: 'found', domain: { ...BASE, expiresAt } })
const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

function setup(lookups: Lookup[], renew?: Write<{ expiresAt: string | null }>) {
  const queue = [...lookups]
  const registrar = {
    lookup: vi.fn(async () => {
      const next = queue.shift()
      if (!next) throw new Error('unexpected lookup')
      return next
    }),
    register: vi.fn(),
    renew: vi.fn(async () => {
      if (!renew) throw new Error('unexpected renew')
      return renew
    }),
    setNameservers: vi.fn(),
  } satisfies Registrar
  const noteBaseline = vi.fn(async (expiresAt: string) => expiresAt)
  const task = (over: Partial<RenewalTask> = {}): RenewalTask => ({
    domainName: 'example.com',
    years: 1,
    baseline: null,
    noteBaseline,
    ...over,
  })
  return { registrar, noteBaseline, task }
}

describe('renewedSince', () => {
  it('counts the years added, allowing for a registry’s rounding either way', () => {
    const base = '2027-09-23T10:00:00.000Z'
    expect(renewedSince(base, '2028-09-23T10:00:00.000Z', 1)).toBe(true)
    expect(renewedSince(base, '2028-09-22T00:00:00.000Z', 1)).toBe(true)
    expect(renewedSince(base, '2028-09-20T00:00:00.000Z', 1)).toBe(false)
    expect(renewedSince(base, '2028-09-23T10:00:00.000Z', 2)).toBe(false)
    expect(renewedSince(base, '2029-09-23T10:00:00.000Z', 2)).toBe(true)
  })

  it('adds calendar years', () => {
    expect(addYears('2028-02-29T00:00:00.000Z', 1).toISOString()).toBe('2029-03-01T00:00:00.000Z')
  })
})

describe('runRenewal', () => {
  it('notes the baseline before renewing, and reads the new expiry back', async () => {
    const { registrar, noteBaseline, task } = setup(
      [at('2027-09-23T10:00:00.000Z'), at('2029-09-23T10:00:00.000Z')],
      { kind: 'ok', data: { expiresAt: null } },
    )
    const outcome = await runRenewal(registrar, task({ years: 2 }))
    expect(outcome).toEqual({
      kind: 'renewed',
      domain: { ...BASE, expiresAt: '2029-09-23T10:00:00.000Z' },
      recovered: false,
    })
    expect(noteBaseline).toHaveBeenCalledWith('2027-09-23T10:00:00.000Z')
    expect(noteBaseline.mock.invocationCallOrder[0]).toBeLessThan(
      registrar.renew.mock.invocationCallOrder[0] ?? 0,
    )
    expect(registrar.renew).toHaveBeenCalledWith('example.com', 2)
  })

  it('renews a domain in its grace period from its old expiry', async () => {
    const { registrar, task } = setup(
      [at('2026-09-01T10:00:00.000Z'), at('2027-09-01T10:00:00.000Z')],
      { kind: 'ok', data: { expiresAt: '2027-09-01T10:00:00.000Z' } },
    )
    expect(await runRenewal(registrar, task())).toMatchObject({ kind: 'renewed' })
  })

  it('refuses a domain that is not in our account, without calling Renew', async () => {
    const { registrar, task } = setup([{ kind: 'not_found' }])
    expect(await runRenewal(registrar, task())).toMatchObject({
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
    })
    expect(registrar.renew).not.toHaveBeenCalled()
  })

  it('waits when the registry cannot be read, or gives no expiry', async () => {
    for (const lookup of [timedOut, at(null)]) {
      const { registrar, task } = setup([lookup])
      expect(await runRenewal(registrar, task())).toMatchObject({ kind: 'unknown' })
      expect(registrar.renew).not.toHaveBeenCalled()
    }
  })

  it('finishes without renewing again when an earlier attempt already landed', async () => {
    const { registrar, noteBaseline, task } = setup([at('2028-09-23T10:00:00.000Z')])
    const outcome = await runRenewal(registrar, task({ baseline: '2027-09-23T10:00:00.000Z' }))
    expect(outcome).toMatchObject({ kind: 'renewed', recovered: true })
    expect(registrar.renew).not.toHaveBeenCalled()
    expect(noteBaseline).not.toHaveBeenCalled()
  })

  it('stops for a person when the expiry moved by less than was paid for', async () => {
    const { registrar, task } = setup([at('2028-09-23T10:00:00.000Z')])
    const outcome = await runRenewal(
      registrar,
      task({ years: 2, baseline: '2027-09-23T10:00:00.000Z' }),
    )
    expect(outcome).toMatchObject({ kind: 'unknown', code: 'EXPIRY_MOVED' })
    expect(registrar.renew).not.toHaveBeenCalled()
  })

  it('calls again, from the stored baseline, when the earlier call did not land', async () => {
    const { registrar, noteBaseline, task } = setup(
      [at('2027-09-23T10:00:00.000Z'), at('2028-09-23T10:00:00.000Z')],
      { kind: 'ok', data: { expiresAt: null } },
    )
    noteBaseline.mockResolvedValueOnce('2027-09-23T10:00:00.000Z')
    const outcome = await runRenewal(registrar, task({ baseline: '2027-09-23T10:00:00.000Z' }))
    expect(outcome).toMatchObject({ kind: 'renewed', recovered: false })
    expect(noteBaseline).toHaveBeenCalledWith('2027-09-23T10:00:00.000Z')
  })

  it('passes a refusal on: the line fails and is refunded', async () => {
    const { registrar, task } = setup([at('2027-09-23T10:00:00.000Z')], {
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
      message: 'No',
    })
    expect(await runRenewal(registrar, task())).toEqual({
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
      message: 'No',
    })
  })

  it('reports refused credentials as blocked', async () => {
    const { registrar, task } = setup([at('2027-09-23T10:00:00.000Z')], {
      kind: 'blocked',
      code: 'SUPPLIER_AUTH',
      message: 'Bad key',
    })
    expect(await runRenewal(registrar, task())).toMatchObject({ kind: 'blocked' })
  })

  it('reads an unanswered call that did land as renewed', async () => {
    const { registrar, task } = setup(
      [at('2027-09-23T10:00:00.000Z'), at('2028-09-23T10:00:00.000Z')],
      timedOut,
    )
    expect(await runRenewal(registrar, task())).toMatchObject({ kind: 'renewed', recovered: true })
  })

  it('reads an unanswered call that did not land as safe to try again', async () => {
    const { registrar, task } = setup(
      [at('2027-09-23T10:00:00.000Z'), at('2027-09-23T10:00:00.000Z')],
      timedOut,
    )
    expect(await runRenewal(registrar, task())).toEqual({
      kind: 'not_renewed',
      code: 'TIMEOUT',
      message: 'No answer',
    })
  })

  it('keeps an unanswered call unknown when the record cannot be read after it', async () => {
    const { registrar, task } = setup([at('2027-09-23T10:00:00.000Z'), timedOut], timedOut)
    expect(await runRenewal(registrar, task())).toMatchObject({ kind: 'unknown', code: 'TIMEOUT' })
  })

  it('keeps an accepted renewal unknown until the new expiry shows', async () => {
    const { registrar, task } = setup(
      [at('2027-09-23T10:00:00.000Z'), at('2027-09-23T10:00:00.000Z')],
      { kind: 'ok', data: { expiresAt: '2028-09-23T10:00:00.000Z' } },
    )
    expect(await runRenewal(registrar, task())).toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
  })
})
