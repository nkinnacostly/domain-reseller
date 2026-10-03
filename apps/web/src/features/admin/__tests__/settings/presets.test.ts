import { describe, expect, it } from 'vitest'
import {
  canPublish,
  checkDetail,
  checkResultWords,
  type DraftRow,
  draftCheckWords,
  isFailing,
  isOpen,
  needsReverify,
  type PresetRow,
  parseNameservers,
  pinnedTone,
  presetHealth,
  sourceHost,
  sourceUrlProblem,
  verifiedWords,
} from '@/features/admin/lib/settings-presets'

/**
 * Presets in words (docs/ADMIN-SPEC.md §5.2 B13, D21): health, the draft's
 * check, when a draft may be published, and the nameservers as typed. The
 * hostnames here are test fixtures, not any provider's (N11).
 */

function presetRow(overrides: Partial<PresetRow> = {}): PresetRow {
  return {
    id: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
    provider: 'Example Host',
    nameservers: ['ns1.example-host.test', 'ns2.example-host.test'],
    assignsPerZone: false,
    sourceUrl: 'https://docs.example-host.test/nameservers',
    notes: null,
    verifiedAt: '2026-09-23T00:01:00Z',
    lastCheckedAt: '2026-10-03T13:05:00Z',
    checkFailedSince: null,
    autoHiddenAt: null,
    isHidden: false,
    registrarDefaultFor: null,
    lastCheck: null,
    ...overrides,
  }
}

function draftRow(overrides: Partial<DraftRow> = {}): DraftRow {
  return {
    id: '5e1f0a9c-1111-4222-8333-444455556666',
    presetId: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
    provider: 'Example Host',
    nameservers: ['ns3.example-host.test', 'ns4.example-host.test'],
    sourceUrl: 'https://docs.example-host.test/nameservers',
    notes: null,
    assignsPerZone: false,
    savedBy: 'owner',
    savedAt: '2026-10-03T12:00:00Z',
    checkOk: null,
    checkedAt: null,
    checkDetail: null,
    publishedAt: null,
    discardedAt: null,
    ...overrides,
  }
}

const NOW = new Date('2026-10-03T14:00:00Z')

describe("a preset's health", () => {
  it('puts who hid it first, then the public-DNS check', () => {
    expect(presetHealth(presetRow({ registrarDefaultFor: 'live' }))).toEqual({
      key: 'default',
      tone: 'neutral',
      words: 'Registrar default',
    })
    expect(
      presetHealth(presetRow({ autoHiddenAt: '2026-10-02T00:00:00Z', isHidden: true })).words,
    ).toBe('Hidden by the checker')
    expect(presetHealth(presetRow({ isHidden: true })).words).toBe('Hidden by a person')
    expect(presetHealth(presetRow({ checkFailedSince: '2026-10-03T08:00:00Z' }))).toEqual({
      key: 'failing',
      tone: 'warning',
      words: 'Failing since 3 Oct 2026, 09:00 WAT',
    })
    expect(presetHealth(presetRow({ assignsPerZone: true, nameservers: [] })).words).toBe(
      'Per domain — not checked',
    )
    expect(presetHealth(presetRow({ lastCheckedAt: null })).words).toBe('Not checked yet')
    expect(presetHealth(presetRow())).toEqual({
      key: 'ok',
      tone: 'ok',
      words: 'Answers in public DNS',
    })
  })

  it('counts a preset as failing while its check fails or the checker has hidden it', () => {
    expect(isFailing(presetRow())).toBe(false)
    expect(isFailing(presetRow({ checkFailedSince: '2026-10-03T08:00:00Z' }))).toBe(true)
    expect(isFailing(presetRow({ autoHiddenAt: '2026-10-03T08:00:00Z' }))).toBe(true)
  })

  it('asks for re-verification after 90 days, and says so', () => {
    expect(needsReverify('2026-09-23T00:00:00Z', NOW)).toBe(false)
    expect(needsReverify('2026-06-01T00:00:00Z', NOW)).toBe(true)
    expect(needsReverify(null, NOW)).toBe(true)
    expect(needsReverify('nonsense', NOW)).toBe(true)
    expect(verifiedWords('2026-09-23T00:00:00Z', NOW)).toBe('23 Sept 2026')
    expect(verifiedWords('2026-06-01T00:00:00Z', NOW)).toBe(
      "1 Jun 2026 — over 90 days ago: check it against the provider's documentation",
    )
    expect(verifiedWords(null, NOW)).toBe('Never verified')
  })
})

describe('a recorded check', () => {
  it('keeps host names and verdicts only', () => {
    expect(
      checkDetail({
        unresolved: ['ns2.example-host.test', 7],
        hosts: [
          {
            host: 'ns1.example-host.test',
            verdict: 'resolves',
            views: [{ addresses: ['1.2.3.4'] }],
          },
          { host: 'ns2.example-host.test' },
          'nonsense',
        ],
      }),
    ).toEqual({
      unresolved: ['ns2.example-host.test'],
      hosts: [
        { host: 'ns1.example-host.test', verdict: 'resolves' },
        { host: 'ns2.example-host.test', verdict: '' },
      ],
    })
    expect(checkDetail(null)).toBeNull()
    expect(checkDetail([])).toBeNull()
    expect(checkDetail({})).toEqual({ unresolved: [], hosts: [] })
  })
})

describe('the check words', () => {
  const at = '2026-10-03T13:05:00Z'

  it("says the gateway's on-demand answer: “Checked at 14:05 WAT: both hosts answer.”", () => {
    const hosts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ host: `ns${index}.x.test`, ok: true }))
    expect(checkResultWords({ ok: true, hosts: hosts(2), checkedAt: at })).toBe(
      'Checked at 14:05 WAT: both hosts answer.',
    )
    expect(checkResultWords({ ok: true, hosts: hosts(1), checkedAt: at })).toBe(
      'Checked at 14:05 WAT: the host answers.',
    )
    expect(checkResultWords({ ok: true, hosts: hosts(3), checkedAt: at })).toBe(
      'Checked at 14:05 WAT: all 3 hosts answer.',
    )
    expect(
      checkResultWords({
        ok: false,
        hosts: [
          { host: 'ns1.x.test', ok: true },
          { host: 'ns2.x.test', ok: false },
          { host: 'ns3.x.test', ok: false },
        ],
        checkedAt: at,
      }),
    ).toBe(
      "Checked at 14:05 WAT: ns2.x.test and ns3.x.test didn't answer. It can't be published until a check passes.",
    )
    expect(checkResultWords({ ok: false, hosts: [], checkedAt: at })).toBe(
      "Checked at 14:05 WAT: the public resolvers didn't answer, so nothing was recorded. Try again in a minute.",
    )
  })

  it("says the draft's recorded check", () => {
    expect(draftCheckWords(draftRow())).toEqual({
      tone: 'info',
      words: 'Not checked yet. The gateway checks open drafts within 6 hours, or press Check now.',
    })
    expect(draftCheckWords(draftRow({ assignsPerZone: true, nameservers: [] })).tone).toBe(
      'neutral',
    )
    expect(draftCheckWords(draftRow({ checkOk: true, checkedAt: at, checkDetail: null }))).toEqual({
      tone: 'ok',
      words: 'Checked 3 Oct 2026, 14:05 WAT: both hosts answer.',
    })
    expect(
      draftCheckWords(
        draftRow({
          checkOk: false,
          checkedAt: at,
          checkDetail: { unresolved: ['ns4.example-host.test'], hosts: [] },
        }),
      ).words,
    ).toBe(
      "Checked 3 Oct 2026, 14:05 WAT: ns4.example-host.test didn't resolve. It can't be published until a check passes.",
    )
    expect(
      draftCheckWords(
        draftRow({
          checkOk: false,
          checkedAt: at,
          checkDetail: {
            unresolved: [],
            hosts: [
              { host: 'ns3.example-host.test', verdict: 'resolves' },
              { host: 'ns4.example-host.test', verdict: 'fails' },
            ],
          },
        }),
      ).words,
    ).toContain('ns4.example-host.test didn')
    expect(draftCheckWords(draftRow({ checkOk: false, checkedAt: at })).words).toBe(
      "Checked 3 Oct 2026, 14:05 WAT: the check failed. It can't be published until a check passes.",
    )
  })
})

describe('publishing a draft', () => {
  it('waits for a check that passed after the draft was saved', () => {
    expect(canPublish(draftRow())).toBe(false)
    expect(canPublish(draftRow({ checkOk: true, checkedAt: '2026-10-03T12:30:00Z' }))).toBe(true)
    expect(canPublish(draftRow({ checkOk: true, checkedAt: '2026-10-03T11:30:00Z' }))).toBe(false)
    expect(canPublish(draftRow({ checkOk: false, checkedAt: '2026-10-03T12:30:00Z' }))).toBe(false)
  })

  it('has nothing to wait for on a per-domain host, and is never offered once closed', () => {
    expect(canPublish(draftRow({ assignsPerZone: true, nameservers: [] }))).toBe(true)
    expect(
      canPublish(draftRow({ assignsPerZone: true, publishedAt: '2026-10-03T13:00:00Z' })),
    ).toBe(false)
    expect(isOpen(draftRow({ discardedAt: '2026-10-03T13:00:00Z' }))).toBe(false)
  })
})

describe('nameservers as typed', () => {
  it('takes one per line, or commas and spaces, lower-cased with a trailing dot dropped', () => {
    expect(parseNameservers('NS1.Example-Host.test.\n ns2.example-host.test , ', false)).toEqual({
      ok: true,
      hosts: ['ns1.example-host.test', 'ns2.example-host.test'],
    })
  })

  it('refuses a non-hostname, a repeat, and fewer than 2 or more than 13', () => {
    expect(parseNameservers('ns1.example.test\nns2_bad.example.test', false)).toEqual({
      ok: false,
      error: 'ns2_bad.example.test is not a hostname such as ns1.example.com.',
    })
    expect(parseNameservers('ns1.example.test ns1.example.test', false)).toEqual({
      ok: false,
      error: 'A nameserver is listed twice. Remove the repeat.',
    })
    expect(parseNameservers('ns1.example.test', false)).toEqual({
      ok: false,
      error: 'Give 2 to 13 nameservers, one per line.',
    })
    const many = Array.from({ length: 14 }, (_, index) => `ns${index}.example.test`).join('\n')
    expect(parseNameservers(many, false).ok).toBe(false)
  })

  it('wants none for a host that assigns them per domain', () => {
    expect(parseNameservers('  ', true)).toEqual({ ok: true, hosts: [] })
    expect(parseNameservers('ns1.example.test', true)).toEqual({
      ok: false,
      error: 'A host that gives each domain its own nameservers has none here. Clear the list.',
    })
  })
})

describe('sources and devices', () => {
  it('wants an https address with a host', () => {
    expect(sourceUrlProblem('https://docs.example-host.test/ns')).toBeNull()
    expect(sourceUrlProblem('https://docs.example-host.test')).toBeNull()
    expect(sourceUrlProblem('http://docs.example-host.test/ns')).not.toBeNull()
    expect(sourceUrlProblem('https://user@docs.example-host.test')).not.toBeNull()
    expect(sourceUrlProblem(`https://x.test/${'a'.repeat(500)}`)).not.toBeNull()
    expect(sourceHost('https://docs.example-host.test/ns')).toBe('docs.example-host.test')
    expect(sourceHost('not a url')).toBe('not a url')
  })

  it('tones the pinned devices: all active, some removed, none left', () => {
    expect(pinnedTone(2, 2)).toBe('ok')
    expect(pinnedTone(2, 1)).toBe('warning')
    expect(pinnedTone(2, 0)).toBe('danger')
  })
})
