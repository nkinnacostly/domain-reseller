import { describe, expect, it } from 'vitest'
import {
  attributeHistory,
  type HistoryRow,
  type NameserverEvent,
  revertTarget,
} from '../lib/nameserver-history'

const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
const TRUEHOST = ['ns1.truehost.cloud', 'ns2.truehost.cloud']
const DEFAULT = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']

const row = (before: string[] | null, after: string[], changedAt: string): HistoryRow => ({
  before,
  after,
  changedAt,
})
const event = (
  type: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
  actorType = 'user',
): NameserverEvent => ({ type, actorType, payload, createdAt })

describe('attributeHistory (FR-N5)', () => {
  it('credits a change to the newest request for that set made before it took effect', () => {
    const [entry] = attributeHistory(
      [row(DEFAULT, VERCEL, '2026-09-24T10:05:00Z')],
      [
        event('nameservers_requested', '2026-09-20T09:00:00Z', { after: VERCEL }),
        event('nameservers_requested', '2026-09-24T10:00:00Z', {
          before: DEFAULT,
          // Case and order do not make a different set.
          after: ['NS2.vercel-dns.com', 'ns1.vercel-dns.com'],
        }),
        // A later request is not what caused an earlier change.
        event('nameservers_requested', '2026-09-24T11:00:00Z', { after: VERCEL }),
      ],
    )
    expect(entry?.source).toEqual({
      kind: 'request',
      by: 'you',
      requestedAt: '2026-09-24T10:00:00Z',
    })
  })

  it('names our support team, or us, when they asked', () => {
    const history = [row(DEFAULT, VERCEL, '2026-09-24T10:05:00Z')]
    expect(
      attributeHistory(history, [
        event('nameservers_requested', '2026-09-24T10:00:00Z', { after: VERCEL }, 'support'),
      ])[0]?.source,
    ).toMatchObject({ kind: 'request', by: 'support' })
    expect(
      attributeHistory(history, [
        event('nameservers_requested', '2026-09-24T10:00:00Z', { after: VERCEL }, 'system'),
      ])[0]?.source,
    ).toMatchObject({ kind: 'request', by: 'us' })
  })

  it('marks a change found at the registry, written in the same moment', () => {
    const [entry] = attributeHistory(
      [row(VERCEL, TRUEHOST, '2026-09-24T12:00:00Z')],
      [
        // A request for another set is not this change.
        event('nameservers_requested', '2026-09-24T10:00:00Z', { after: VERCEL }),
        event('nameservers_synced', '2026-09-24T12:00:30Z', { after: TRUEHOST }, 'system'),
      ],
    )
    expect(entry?.source).toEqual({ kind: 'registry' })
  })

  it('calls the first set on record just that', () => {
    expect(attributeHistory([row(null, DEFAULT, '2026-09-01T10:00:00Z')], [])[0]?.source).toEqual({
      kind: 'first',
    })
    expect(attributeHistory([row([], DEFAULT, '2026-09-01T10:00:00Z')], [])[0]?.source).toEqual({
      kind: 'first',
    })
  })

  it('says nothing it does not know', () => {
    const [entry] = attributeHistory(
      [row(DEFAULT, VERCEL, '2026-09-24T10:05:00Z')],
      [
        event('nameservers_requested', '2026-09-24T10:00:00Z', { after: 'not a list' }),
        event('nameservers_synced', '2026-09-23T10:00:00Z', {}, 'system'),
      ],
    )
    expect(entry?.source).toEqual({ kind: 'unknown' })
  })

  it('keeps the history’s own order and fields', () => {
    const history = [
      row(VERCEL, TRUEHOST, '2026-09-24T12:00:00Z'),
      row(DEFAULT, VERCEL, '2026-09-20T12:00:00Z'),
    ]
    expect(attributeHistory(history, []).map((entry) => entry.after)).toEqual([TRUEHOST, VERCEL])
  })
})

describe('revertTarget', () => {
  const domain = {
    status: 'active',
    previousNameservers: VERCEL,
    nameservers: TRUEHOST,
    pendingNameservers: null,
  }

  it('offers the previous set on an active domain', () => {
    expect(revertTarget(domain)).toEqual({ nameservers: VERCEL, waiting: false })
    expect(revertTarget({ ...domain, status: 'pending' })).toEqual({
      nameservers: VERCEL,
      waiting: false,
    })
  })

  it('offers nothing when there is nothing to go back to', () => {
    expect(revertTarget({ ...domain, previousNameservers: null })).toBeNull()
    expect(revertTarget({ ...domain, previousNameservers: [] })).toBeNull()
  })

  it('says it is waiting when the previous set is already on its way, or held', () => {
    expect(revertTarget({ ...domain, pendingNameservers: [...VERCEL].reverse() })).toEqual({
      nameservers: VERCEL,
      waiting: true,
    })
    expect(revertTarget({ ...domain, nameservers: VERCEL })?.waiting).toBe(true)
  })

  it('offers nothing where a nameserver change cannot be asked for', () => {
    expect(revertTarget({ ...domain, status: 'expired_grace' })).toBeNull()
    expect(revertTarget({ ...domain, status: 'transfer_pending' })).toBeNull()
  })
})
