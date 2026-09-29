// The subpath, not the package root: client components use these words too.
import { renewalSuffix } from '@dr/shared/pricing'

/**
 * How a price and its term read, everywhere a price is shown (N8, N9b).
 *
 * Most extensions sell a year at a time, and read as they always have: "first
 * year", "/yr", "a year". Some registries sell only blocks — .ai two, four,
 * six, eight or ten years — and a per-year figure there would suggest a year
 * that cannot be bought. So a longer term is named with its whole price: "for
 * 2 years (the shortest term .ai allows)", "every 2 years".
 */

/** "1 year", "2 years". */
export function yearsText(count: number): string {
  return `${count} ${count === 1 ? 'year' : 'years'}`
}

/** Beside the first price: "first year", or "for 2 years" where the shortest term is longer. */
export function firstTermLabel(years: number): string {
  return years === 1 ? 'first year' : `for ${yearsText(years)}`
}

/** Why the first price covers more than a year. */
export function shortestTermNote(tld: string): string {
  return `the shortest term .${tld} allows`
}

/** A renewal price and its term: "₦18,700/yr", "₦273,000 every 2 years". */
export function renewalText(price: string, years: number): string {
  return `${price}${renewalSuffix(years)}`
}

/** "₦18,300 for the first year", or "₦273,000 for 2 years (the shortest term .ai allows)". */
export function firstTermPhrase(tld: string, price: string, years: number): string {
  return years === 1
    ? `${price} for the first year`
    : `${price} for ${yearsText(years)} (${shortestTermNote(tld)})`
}

/** "₦18,700 a year", or "₦273,000 every 2 years". */
export function renewalPhrase(price: string, years: number): string {
  return years === 1 ? `${price} a year` : `${price} every ${yearsText(years)}`
}

/** "the first year" beside a one-year term, "the first 2 years" beside a longer one. */
export function firstTermName(years: number): string {
  return years === 1 ? 'the first year' : `the first ${yearsText(years)}`
}

/**
 * "2, 4, 6, 8 or 10 years": the periods an extension sells, for a sentence.
 * A run of every year reads as a range instead: "1 to 10 years".
 */
export function periodsText(periods: readonly number[]): string {
  const [first] = periods
  const last = periods.at(-1)
  if (first === undefined || last === undefined) return ''
  if (first === last) return yearsText(first)
  if (last - first + 1 === periods.length) return `${first} to ${yearsText(last)}`
  return `${periods.slice(0, -1).join(', ')} or ${yearsText(last)}`
}
