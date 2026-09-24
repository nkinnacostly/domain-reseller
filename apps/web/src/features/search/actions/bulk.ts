'use server'

import { domainStemSchema } from '@dr/shared/schemas'
import { z } from 'zod'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { actionClient } from '@/lib/safe-action'
import { BULK_CHUNK } from '../lib/bulk'
import type { BulkAnswer, BulkPrice } from '../lib/bulk-run'
import { lengthIssue } from '../lib/length'
import { checkAvailability } from '../queries/availability'
import { getLengthRules } from '../queries/length-rules'

/**
 * Longer than a single search waits: bulk queues behind every other search at
 * the gateway (FR-S5), which holds it for up to 20 s before giving up.
 */
const BULK_TIMEOUT_MS = 30_000

const extensionSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/)

/**
 * One block of a bulk search (FR-S5): up to fifty names on the extensions
 * they need, asked at low priority so single searches always go first.
 *
 * The page plans the list and sends the blocks one at a time; this re-checks
 * what it is sent, because anyone can call it: extensions we don't sell and
 * names an extension's length rule refuses are never sent on (FR-S9).
 *
 * Limited per address, counted per block — so what a list costs grows with
 * its length: a 500-name list is ten blocks, and a script cannot keep the
 * supplier busy for everyone (the gateway also keeps bulk to one of its two
 * slots). Nothing is logged: the names are search queries (FR-S7).
 */
export const checkBulkNames = actionClient
  .inputSchema(
    z.object({
      names: z.array(domainStemSchema).min(1).max(BULK_CHUNK.maxNames),
      tlds: z.array(extensionSchema).min(1).max(BULK_CHUNK.maxTlds),
    }),
  )
  .action(async ({ parsedInput }): Promise<BulkAnswer> => {
    const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])
    // Without prices nothing can be shown for an available name (N8, N5b).
    if (!priced) return { ok: false, reason: 'unavailable' }

    const byTld = new Map(priced.tlds.map((tld) => [tld.tld, tld]))
    const tlds = [...new Set(parsedInput.tlds)].filter((tld) => byTld.has(tld))
    const names = [...new Set(parsedInput.names)].filter((name) =>
      tlds.every((tld) => !lengthIssue(name, lengthRules[tld])),
    )
    if (tlds.length === 0 || names.length === 0) return { ok: true, results: [], prices: {} }

    if (!(await withinLimit(await addressKey('bulk_search'), LIMITS.bulkSearch))) {
      return { ok: false, reason: 'limited' }
    }

    const outcome = await checkAvailability(names, tlds, 'low', { timeoutMs: BULK_TIMEOUT_MS })
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason === 'rate-limited' ? 'busy' : 'unavailable' }
    }

    const prices: Record<string, BulkPrice> = {}
    for (const tld of tlds) {
      const pricing = byTld.get(tld)
      if (!pricing) continue
      const row = toPublicRow(pricing)
      prices[tld] = {
        register: row.register,
        renew: row.renew,
        renewalIsHigher: row.renewalIsHigher,
        includesIcannFee: !row.isCountryCode,
        maxPeriod: row.maxPeriod,
        registerKobo: pricing.registration.priceKobo,
        renewKobo: pricing.renewal.priceKobo,
      }
    }
    return {
      ok: true,
      results: outcome.results.map(({ domain, status }) => ({ domain, status })),
      prices,
    }
  })
