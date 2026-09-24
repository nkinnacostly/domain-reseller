/**
 * Splits a list into runs of at most `size`. A read by id for hundreds of
 * domains goes to PostgREST as a query string; 500 ids in one `in.(…)` is
 * about 18 KB, past what proxies in front of it accept, so bulk reads ask
 * in runs instead.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1')
  const runs: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    runs.push(items.slice(start, start + size))
  }
  return runs
}

/** Ids per read by id: about 3.7 KB of query string. */
export const IDS_PER_READ = 100
