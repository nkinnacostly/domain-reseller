import { describe, expect, it } from 'vitest'
import {
  applySummary,
  heartbeatFrom,
  heartbeatWords,
  previewSummary,
  reportBlocks,
} from '@/features/admin/lib/supplier-catalogue'
import { preview } from './fixtures'

describe('a preview, summarised (D19)', () => {
  it('counts what was listed, what is sellable and what would change', () => {
    expect(previewSummary(preview())).toEqual({
      tone: 'info',
      headline: '3 changes waiting. The weekly sync writes them, or apply now.',
      counts: '724 extensions listed · 705 sellable · 3 changes',
    })
    expect(previewSummary(preview({ changes: 1 })).headline).toBe(
      '1 change waiting. The weekly sync writes it, or apply now.',
    )
  })

  it('says when nothing would change', () => {
    expect(previewSummary(preview({ changes: 0 }))).toMatchObject({
      tone: 'ok',
      headline: 'Up to date: applying now would change nothing.',
    })
  })

  it('says the sync would refuse a listing that looks broken, with its reason', () => {
    expect(
      previewSummary(preview({ outcome: 'refused', reason: '40 extensions retired at once' })),
    ).toMatchObject({
      tone: 'warning',
      headline:
        'The sync would refuse this listing: 40 extensions retired at once. Applying writes nothing until it looks right.',
    })
    expect(previewSummary(preview({ outcome: 'failed', reason: null })).headline).toBe(
      "DomainNameAPI's listing couldn't be read. Try again later.",
    )
  })

  it('counts SSL products as products', () => {
    expect(
      previewSummary(preview({ kind: 'ssl', listed: 1, sellable: 1, changes: 0 })).counts,
    ).toBe('1 product listed · 1 sellable · 0 changes')
  })
})

describe('the report (the sync’s own words)', () => {
  it('renders in blocks split at blank lines, each led by its first line, nothing dropped', () => {
    expect(reportBlocks(preview().report)).toEqual([
      { lead: 'Fetched 724 extensions from the reseller platform; 705 sellable', lines: [] },
      {
        lead: '+1 added · -0 retired · ~2 price changes · ~0 other changes · 721 unchanged',
        lines: [],
      },
      { lead: 'Added:   .africa', lines: [] },
      {
        lead: 'Wholesale changes:',
        lines: [
          '.com             register $11.31 → $11.48   renew $11.31 → $11.48',
          '.net             register $13.10 → $13.40   renew $13.10 → $13.40',
        ],
      },
      { lead: 'Report only. Re-run with --apply to write.', lines: [] },
    ])
  })

  it('keeps a report with no blank lines as one block, and an empty one as none', () => {
    expect(reportBlocks(['one', '  two'])).toEqual([{ lead: 'one', lines: ['two'] }])
    expect(reportBlocks([])).toEqual([])
    expect(reportBlocks(['', '', 'x', ''])).toEqual([{ lead: 'x', lines: [] }])
  })
})

describe('an apply, in words', () => {
  const at = '2026-10-03T13:00:00Z'
  it('says what was written, or that nothing needed changing', () => {
    expect(applySummary({ outcome: 'applied', reason: null, changes: 3, readAt: at })).toEqual({
      ok: true,
      words: 'Applied 3 changes. Site prices update on the next refresh.',
    })
    expect(applySummary({ outcome: 'applied', reason: null, changes: 0, readAt: at })).toEqual({
      ok: true,
      words: 'Applied: nothing needed changing.',
    })
  })

  it('says a refused listing wrote nothing, and a failed run may have written part', () => {
    expect(
      applySummary({ outcome: 'refused', reason: 'too many retired', changes: 0, readAt: at }),
    ).toEqual({
      ok: false,
      words: 'The sync refused the listing, so nothing was written: too many retired.',
    })
    expect(applySummary({ outcome: 'failed', reason: null, changes: 0, readAt: at }).words).toBe(
      'The sync failed part-way. Preview again to see what was written.',
    )
  })
})

describe('the weekly sync’s last run', () => {
  it('reads counts only from its heartbeat, never prices', () => {
    const beat = heartbeatFrom({
      beat_at: '2026-10-01T12:03:10Z',
      detail: {
        outcome: 'written',
        added: 0,
        retired: 0,
        priceChanges: 2,
        otherChanges: 1,
        listed: 724,
      },
    })
    expect(beat).toEqual({ beatAt: '2026-10-01T12:03:10Z', outcome: 'written', changes: 3 })
    expect(heartbeatWords(beat as NonNullable<typeof beat>, '1 Oct 2026, 13:03 WAT')).toBe(
      'Last sync 1 Oct 2026, 13:03 WAT: wrote its changes (3 changes).',
    )
  })

  it('words every outcome, and survives a detail it cannot read', () => {
    const words = (outcome: unknown) =>
      heartbeatWords(
        heartbeatFrom({ beat_at: 'x', detail: { outcome } }) as NonNullable<
          ReturnType<typeof heartbeatFrom>
        >,
        'then',
      )
    expect(words('unchanged')).toBe('Last sync then: found nothing to change.')
    expect(words('refused')).toBe('Last sync then: refused the listing.')
    expect(words('failed')).toBe('Last sync then: failed.')
    expect(words('new_word')).toBe('Last sync then: new word.')
    expect(words(undefined)).toBe('Last sync then: ran.')
    expect(heartbeatFrom({ beat_at: 'x', detail: 'odd' })).toEqual({
      beatAt: 'x',
      outcome: null,
      changes: null,
    })
    expect(heartbeatFrom(null)).toBeNull()
  })
})
