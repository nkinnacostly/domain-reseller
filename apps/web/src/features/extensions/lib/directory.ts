import { POPULAR_TLDS } from '@/features/pricing/lib/public-row'

export type DirectoryGroup = { letter: string; tlds: string[] }

export type Directory = {
  popular: string[]
  generic: DirectoryGroup[]
  country: DirectoryGroup[]
  total: number
}

/**
 * The A–Z directory (/domains): the extensions people here know first, then
 * generic and country extensions each by first letter. Second-level
 * extensions such as com.ng sort under their own first letter.
 */
export function buildDirectory(entries: { tld: string; isCountryCode: boolean }[]): Directory {
  const unique = [...new Map(entries.map((entry) => [entry.tld, entry])).values()]
  const sold = new Set(unique.map((entry) => entry.tld))
  const byLetter = (tlds: string[]): DirectoryGroup[] => {
    const groups = new Map<string, string[]>()
    for (const tld of [...tlds].sort()) {
      const letter = /^[a-z]/.test(tld) ? (tld[0] ?? '#').toUpperCase() : '#'
      groups.set(letter, [...(groups.get(letter) ?? []), tld])
    }
    return [...groups.entries()].map(([letter, list]) => ({ letter, tlds: list }))
  }
  return {
    popular: POPULAR_TLDS.filter((tld) => sold.has(tld)),
    generic: byLetter(unique.filter((entry) => !entry.isCountryCode).map((entry) => entry.tld)),
    country: byLetter(unique.filter((entry) => entry.isCountryCode).map((entry) => entry.tld)),
    total: unique.length,
  }
}
