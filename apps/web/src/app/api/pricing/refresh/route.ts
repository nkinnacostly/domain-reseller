import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import { loadPricedCatalogue, readPricedCatalogue } from '@/features/pricing/queries/pricing'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'

/**
 * Puts new prices on the site as soon as the pricing jobs write them
 * (backlog L8), instead of within the hour the cache otherwise takes.
 *
 * It needs no secret: it compares the cached prices with the database and
 * expires the cache only when they differ. Anyone can call it, and the most
 * it can do is refresh prices that really have changed — once — so a caller
 * gains nothing. Rate-limited all the same.
 */
export async function POST() {
  if (!(await withinLimit('pricing:refresh', LIMITS.pricingRefresh))) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }

  let cached: string
  let current: string
  try {
    const [before, now] = await Promise.all([loadPricedCatalogue(), readPricedCatalogue()])
    cached = before?.version ?? 'none'
    current = now?.version ?? 'none'
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
