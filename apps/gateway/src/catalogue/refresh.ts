/**
 * Asks the storefront to put new prices up now rather than within the hour
 * its cache otherwise takes (backlog L8). The route needs no secret: it
 * compares its cached prices with the database and refreshes only when they
 * differ (apps/web/src/app/api/pricing/refresh/route.ts).
 *
 * Never throws: the costs are already written, so a failed nudge only means
 * the site catches up on its own.
 */
export function createPriceRefresh(
  appUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): () => Promise<boolean> {
  const url = new URL('/api/pricing/refresh', appUrl)
  return async () => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
