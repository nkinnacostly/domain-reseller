import { describe, expect, it } from 'vitest'
import {
  firstTermLabel,
  firstTermName,
  firstTermPhrase,
  periodsText,
  renewalPhrase,
  renewalText,
  shortestTermNote,
  yearsText,
} from '../lib/terms'

/**
 * How a price and its term read (N8, N9b): a one-year extension exactly as
 * it always has, and one sold only in blocks by its real terms — never a
 * per-year figure that suggests a year nobody can buy.
 */
describe('price terms', () => {
  it('reads a one-year extension as it always has', () => {
    expect(firstTermLabel(1)).toBe('first year')
    expect(firstTermName(1)).toBe('the first year')
    expect(renewalText('₦18,700', 1)).toBe('₦18,700/yr')
    expect(firstTermPhrase('com', '₦18,300', 1)).toBe('₦18,300 for the first year')
    expect(renewalPhrase('₦18,700', 1)).toBe('₦18,700 a year')
  })

  it('names the whole term where the registry sells no single year (.ai)', () => {
    expect(firstTermLabel(2)).toBe('for 2 years')
    expect(firstTermName(2)).toBe('the first 2 years')
    expect(shortestTermNote('ai')).toBe('the shortest term .ai allows')
    expect(renewalText('₦273,000', 2)).toBe('₦273,000 every 2 years')
    expect(firstTermPhrase('ai', '₦273,000', 2)).toBe(
      '₦273,000 for 2 years (the shortest term .ai allows)',
    )
    expect(renewalPhrase('₦273,000', 2)).toBe('₦273,000 every 2 years')
  })

  it('counts years in words that agree', () => {
    expect(yearsText(1)).toBe('1 year')
    expect(yearsText(2)).toBe('2 years')
  })

  it('lists the periods sold: a run as a range, blocks one by one', () => {
    expect(periodsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('1 to 10 years')
    expect(periodsText([2, 4, 6, 8, 10])).toBe('2, 4, 6, 8 or 10 years')
    expect(periodsText([2])).toBe('2 years')
    expect(periodsText([1])).toBe('1 year')
    expect(periodsText([])).toBe('')
  })
})
