import 'server-only'

import { cache } from 'react'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'

/**
 * FR-S5 — whether this address may run a bulk search now. Counted once per
 * request however many parts of the page ask, and only for a search that
 * will reach the supplier.
 */
export const bulkSearchAllowed = cache(
  async (): Promise<boolean> => withinLimit(await addressKey('bulk_search'), LIMITS.bulkSearch),
)
