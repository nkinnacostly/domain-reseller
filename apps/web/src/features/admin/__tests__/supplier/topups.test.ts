import { describe, expect, it } from 'vitest'
import {
  correctionsOf,
  creditLine,
  formatPaid,
  formatRate,
  MAX_NGN_PAID_KOBO,
  nairaToKobo,
  rateAgainstCosting,
  rateKoboPerCent,
  rateLine,
  type TopupHistoryRow,
} from '@/features/admin/lib/supplier-topups'

describe('the effective rate, in numeric kobo per cent (§3.2b)', () => {
  it('is naira paid over dollars credited, exactly as SQL works it', () => {
    // ₦58,320 for $36.00: ₦1,620 to the dollar.
    expect(rateKoboPerCent(5_832_000, 3600)).toBe('1620.0000')
    // ₦24,300 for $15.00.
    expect(rateKoboPerCent(2_430_000, 1500)).toBe('1620.0000')
  })

  it('is never integer division: a third keeps its places', () => {
    expect(rateKoboPerCent(100, 3)).toBe('33.3333')
    expect(rateKoboPerCent(200, 3)).toBe('66.6667')
    expect(rateKoboPerCent(1, 8)).toBe('0.1250')
  })

  it('rounds half away from zero at the fourth place, as round(numeric, 4) does', () => {
    expect(rateKoboPerCent(5, 20_000)).toBe('0.0003')
    expect(rateKoboPerCent(1, 30_000)).toBe('0.0000')
  })

  it('holds for the largest top-up the form takes, with no float on the way', () => {
    expect(rateKoboPerCent(MAX_NGN_PAID_KOBO, 1)).toBe('100000000000.0000')
    expect(rateKoboPerCent(9_007_199_254_740_991, 7)).toBe('1286742750677284.4286')
  })

  it('has no rate without positive whole numbers on both sides', () => {
    expect(rateKoboPerCent(0, 3600)).toBeNull()
    expect(rateKoboPerCent(5_832_000, 0)).toBeNull()
    expect(rateKoboPerCent(-1, 3600)).toBeNull()
    expect(rateKoboPerCent(1.5, 3600)).toBeNull()
  })

  it('shows the rate as naira to the dollar, and how it sits against costing', () => {
    expect(formatRate('1620.0000')).toBe('₦1,620.00/$')
    expect(formatRate(1328.1)).toBe('₦1,328.10/$')
    expect(formatRate(null)).toBe('—')
    expect(formatRate('not a rate')).toBe('—')
    expect(rateAgainstCosting('1620.0000', 1328.1)).toBe('22.0% above costing')
    expect(rateAgainstCosting(1200, 1328.1)).toBe('9.6% below costing')
    expect(rateAgainstCosting(1328.1, 1328.1)).toBe('the same as costing')
    expect(rateAgainstCosting(1620, null)).toBeNull()
    expect(rateAgainstCosting(null, 1328.1)).toBeNull()
  })

  it('writes the dialog rows the spec lists', () => {
    expect(creditLine({ usdCents: 3600, occurredAt: '2026-10-01T09:00:00Z' })).toBe(
      'Ledger credit $36.00 on 1 Oct 2026',
    )
    expect(rateLine('1620.0000', 1328.1)).toBe(
      'Effective rate ₦1,620.00/$ against costing ₦1,328.10/$ (22.0% above costing)',
    )
    expect(rateLine('1620.0000', null)).toBe(
      'Effective rate ₦1,620.00/$; no active costing rate to compare',
    )
  })
})

describe('naira typed by a person', () => {
  it('becomes whole kobo, read as text', () => {
    expect(nairaToKobo('58,320')).toBe(5_832_000)
    expect(nairaToKobo('58320.5')).toBe(5_832_050)
    expect(nairaToKobo(' ₦58,320.50 ')).toBe(5_832_050)
    expect(nairaToKobo('0.29')).toBe(29)
    expect(nairaToKobo('1000000000')).toBe(MAX_NGN_PAID_KOBO)
  })

  it('refuses nothing, zero, three decimal places, words and more than the guard', () => {
    for (const text of ['', '0', '0.00', '1.234', 'abc', '-5', '1e5', '1000000000.01']) {
      expect(nairaToKobo(text), text).toBeNull()
    }
  })

  it('is shown exactly as recorded, kobo included', () => {
    expect(formatPaid(5_832_000)).toBe('₦58,320')
    expect(formatPaid(5_832_050)).toBe('₦58,320.50')
    expect(formatPaid(5)).toBe('₦0.05')
    expect(formatPaid(null)).toBe('—')
    expect(formatPaid(1.5)).toBe('—')
  })
})

describe('corrections (§5.2: the first record stays in history)', () => {
  const row = (id: number, supersedesId: number | null): TopupHistoryRow => ({
    id,
    traceId: 'trace',
    ngnPaidKobo: id * 1000,
    reference: `REF-${id}`,
    supersedesId,
    recordedBy: 'owner',
    recordedAt: '2026-10-01T09:00:00Z',
  })

  it('follows each superseded record back from the current one, newest first', () => {
    const history = [row(7, 6), row(6, 5), row(5, null), row(9, null)]
    expect(correctionsOf({ id: 7, supersedesId: 6 }, history).map((r) => r.id)).toEqual([6, 5])
    expect(correctionsOf({ id: 5, supersedesId: null }, history)).toEqual([])
    expect(correctionsOf({}, history)).toEqual([])
  })

  it('stops at a missing record or a loop rather than hang', () => {
    expect(correctionsOf({ id: 7, supersedesId: 6 }, [row(7, 6)])).toEqual([])
    expect(
      correctionsOf({ id: 1, supersedesId: 2 }, [row(1, 2), row(2, 1)]).map((r) => r.id),
    ).toEqual([2])
  })
})
