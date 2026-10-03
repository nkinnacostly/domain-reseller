import { describe, expect, it } from 'vitest'
import {
  balanceTiles,
  ledgerReadLine,
  liveBalanceDifference,
  liveBalanceLine,
  runwayValue,
  uncostedWords,
} from '@/features/admin/lib/supplier-float'
import { daysAgo, minutesAgo, NOW, supplierFloat } from './fixtures'

const tile = (tiles: ReturnType<typeof balanceTiles>, key: string) =>
  tiles.find((t) => t.key === key)

describe('the runway, as a tile says it', () => {
  it('is about N days on a known 7-day burn', () => {
    expect(runwayValue(supplierFloat())).toBe('about 12 days')
    expect(runwayValue(supplierFloat({ runwayDays: 0.4 }))).toBe('under a day')
    expect(runwayValue(supplierFloat({ runwayDays: 1.2 }))).toBe('about 1 day')
  })

  it('says short-by first: paid-for work the balance cannot cover', () => {
    expect(runwayValue(supplierFloat({ shortByCents: 420, runwayDays: 0 }))).toBe('Short by $4.20')
    expect(runwayValue(supplierFloat({ shortByCents: 420, burnState: 'stale' }))).toBe(
      'Short by $4.20',
    )
  })

  it('is unknown when the ledger is stale or short, never a guess from line costs', () => {
    expect(runwayValue(supplierFloat({ burnState: 'stale' }))).toBe('Unknown')
    expect(runwayValue(supplierFloat({ burnState: 'short_history' }))).toBe('Unknown')
  })

  it('is "No spend" with nothing spent in 7 days, and a dash with no snapshot', () => {
    expect(runwayValue(supplierFloat({ burn7dCents: 0, runwayDays: null }))).toBe('No spend')
    expect(runwayValue(supplierFloat({ balanceCents: null }))).toBe('—')
  })

  it('carries the overview’s own sentence and tone, so both pages agree', () => {
    const runway = tile(balanceTiles(supplierFloat(), NOW, 0), 'runway')
    expect(runway?.hint).toBe("About 12 days at the last 7 days' spend (30-day pace: 14 days)")
    expect(runway?.tone).toBe('ok')
    const low = tile(balanceTiles(supplierFloat({ runwayDays: 2 }), NOW, 0), 'runway')
    expect(low?.tone).toBe('danger')
    const stale = tile(
      balanceTiles(supplierFloat({ burnState: 'stale', ledgerReadAt: minutesAgo(240) }), NOW, 0),
      'runway',
    )
    expect(stale?.hint).toMatch(
      /^Runway unknown — the supplier ledger was last read at 1[0-9]:00 WAT/,
    )
  })
})

describe('balanceTiles', () => {
  it('shows the snapshot with its side and time, committed, burn, runway, target and the alert level', () => {
    const tiles = balanceTiles(supplierFloat(), NOW, 0)
    expect(tiles.map((t) => t.key)).toEqual([
      'snapshot',
      'committed',
      'burn7',
      'burn30',
      'runway',
      'target',
      'alert',
      'unexplained',
    ])
    expect(tile(tiles, 'snapshot')).toMatchObject({
      value: '$43.38',
      hint: 'Taken 14:00 WAT, live side',
    })
    expect(tile(tiles, 'burn7')?.value).toBe('$25.20')
    expect(tile(tiles, 'burn30')?.value).toBe('$90.00')
    expect(tile(tiles, 'target')).toMatchObject({ value: '$75.60', tone: 'warning' })
    expect(tile(tiles, 'target')?.hint).toBe('Keep $75.60 (21 days of spend); top up $32.22.')
    expect(tile(tiles, 'alert')).toMatchObject({ value: '$20.00', tone: 'neutral' })
  })

  it('counts older lines priced at today’s prices beside what is committed', () => {
    expect(uncostedWords(0)).toBeNull()
    expect(uncostedWords(1)).toBe('1 older line not costed')
    const committed = tile(
      balanceTiles(supplierFloat({ committedCents: 1148, uncostedLines: 2 }), NOW, 0),
      'committed',
    )
    expect(committed?.value).toBe('$11.48')
    expect(committed?.hint).toBe(
      "Paid-for work not yet bought: 2 older lines not costed, so counted at today's prices",
    )
    expect(committed?.tone).toBe('info')
  })

  it('flags a balance under the alert level on the snapshot and the alert tiles', () => {
    const tiles = balanceTiles(supplierFloat({ balanceCents: 1500 }), NOW, 0)
    expect(tile(tiles, 'snapshot')?.tone).toBe('warning')
    expect(tile(tiles, 'alert')).toMatchObject({
      tone: 'warning',
      hint: 'The balance is below it: a float-low alert is open',
    })
  })

  it('says when there is no snapshot on the side, and dashes what needs one', () => {
    const tiles = balanceTiles(
      supplierFloat({ side: 'test', balanceCents: null, takenAt: null, alertCents: null }),
      NOW,
      0,
    )
    expect(tile(tiles, 'snapshot')).toMatchObject({
      value: '—',
      hint: 'No balance snapshot on the test side yet',
    })
    expect(tile(tiles, 'alert')?.value).toBe('—')
  })

  it('links unexplained charges to the ledger filtered to them, or leaves the tile out unread', () => {
    const tiles = balanceTiles(supplierFloat(), NOW, 3)
    expect(tile(tiles, 'unexplained')).toMatchObject({
      value: '3',
      tone: 'danger',
      href: '/admin/supplier/ledger?status=unexplained',
    })
    expect(tile(balanceTiles(supplierFloat(), NOW, 0), 'unexplained')?.tone).toBe('ok')
    expect(tile(balanceTiles(supplierFloat(), NOW, null), 'unexplained')).toBeUndefined()
  })

  it('dates a snapshot from another day', () => {
    const tiles = balanceTiles(supplierFloat({ takenAt: daysAgo(2) }), NOW, 0)
    expect(tile(tiles, 'snapshot')?.hint).toBe('Taken 1 Oct 2026, 15:00 WAT, live side')
  })
})

describe('ledgerReadLine', () => {
  it('says when the ledger was last read, and that a stale one makes burn stale', () => {
    expect(ledgerReadLine(supplierFloat(), NOW)).toBe('Supplier ledger last read 14:30 WAT.')
    expect(
      ledgerReadLine(supplierFloat({ burnState: 'stale', ledgerReadAt: minutesAgo(300) }), NOW),
    ).toBe('Supplier ledger last read 10:00 WAT — over 3 hours ago, so burn and runway are stale.')
    expect(ledgerReadLine(supplierFloat({ ledgerReadAt: null }), NOW)).toBe(
      'The supplier ledger has not been read on this side yet.',
    )
  })
})

describe('the live balance line (§5.2)', () => {
  const read = { balanceCents: 4338, readAt: '2026-10-03T13:05:00Z', side: 'live' as const }

  it('reads as the spec writes it, beside the snapshot', () => {
    expect(
      liveBalanceLine(read, { balanceCents: 4338, takenAt: '2026-10-03T13:00:00Z' }, NOW),
    ).toBe('$43.38 at 14:05 WAT on live (snapshot 14:00: $43.38)')
  })

  it('says when the side has no snapshot, and dates a read from another day', () => {
    expect(
      liveBalanceLine({ ...read, side: 'test' }, { balanceCents: null, takenAt: null }, NOW),
    ).toBe('$43.38 at 14:05 WAT on test (no snapshot on this side yet)')
    expect(
      liveBalanceLine(
        { ...read, readAt: '2026-10-01T13:05:00Z' },
        { balanceCents: 4000, takenAt: '2026-10-01T13:00:00Z' },
        NOW,
      ),
    ).toBe('$43.38 at 1 Oct 2026, 14:05 WAT on live (snapshot 14:00: $40.00)')
  })

  it('says how the read differs from the snapshot', () => {
    expect(liveBalanceDifference(4338, 4338)).toBe('The same as the latest snapshot.')
    expect(liveBalanceDifference(3207, 4338)).toBe(
      '$11.31 lower than the latest snapshot: money spent since it was taken.',
    )
    expect(liveBalanceDifference(7938, 4338)).toBe(
      '$36.00 higher than the latest snapshot: money added since it was taken.',
    )
    expect(liveBalanceDifference(4338, null)).toBeNull()
  })
})
