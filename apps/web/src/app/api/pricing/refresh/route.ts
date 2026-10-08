import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import { loadPricedCatalogue, readPricedCatalogue } from '@/features/pricing/queries/pricing'
import { loadSslCatalogue, readSslCatalogue } from '@/features/ssl/queries/catalogue'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'

/**
 * Puts new prices on the site as soon as the pricing jobs write them
 * (backlog L8), instead of within the hour the cache otherwise takes.
 *
 * It needs no secret: it compares the cached prices with the database and
 * expires the cache only when they differ. Anyone can call it, and the most
 * it can do is refresh prices that really have changed — once — so a caller
 * gains nothing. Rate-limited all the same, per caller.
 */
export async function POST() {
  // Counted per caller's address: one shared count let anyone use up the
  // gateway's refreshes for the hour (security audit, 8 Oct 2026).
  if (!(await withinLimit(await addressKey('pricing_refresh'), LIMITS.pricingRefresh))) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }

  let cached: string
  let current: string
  try {
    // Domain and SSL certificate prices (FR-SSL-2) share the `pricing` tag.
    const [before, now, sslBefore, sslNow] = await Promise.all([
      loadPricedCatalogue(),
      readPricedCatalogue(),
      loadSslCatalogue(),
      readSslCatalogue(),
    ])
    cached = `${before?.version ?? 'none'}:${sslBefore?.version ?? 'none'}`
    current = `${now?.version ?? 'none'}:${sslNow?.version ?? 'none'}`
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'pricing refresh could not read prices',
    )
    return NextResponse.json({ ok: false }, { status: 503 })
  }

  if (cached === current) return NextResponse.json({ ok: true, refreshed: false })
  revalidateTag('pricing', { expire: 0 })
  logger.info({ from: cached, to: current }, 'prices refreshed')
  return NextResponse.json({ ok: true, refreshed: true })
}
