'use server'

import type { TldPricing } from '@dr/shared'
import { after as afterResponse } from 'next/server'
import { z } from 'zod'
import { periodsText } from '@/features/pricing/lib/terms'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { packChecks } from '@/features/search/lib/bulk'
import { toUnicodeHost } from '@/features/search/lib/idn'
import { describeLengthIssue, lengthIssue } from '@/features/search/lib/length'
import { parseSearchQuery } from '@/features/search/lib/query'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { requirePaymentEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { actionClient } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { MAX_CART_ITEMS, nearestSoldPeriod, quoteFor, sellsPeriod } from '../lib/lines'
import { existingCartId, ownerForWrite, setCountCookie } from '../queries/owner'
import {
  countLines,
  deleteLine,
  findOrCreateCartId,
  insertLine,
  loadLines,
  loadSslLines,
  requoteSslLine,
  updateLine,
} from '../queries/store'

/**
 * Cart mutations (FR-C1 – FR-C4). Public: anyone may fill a cart; signing in
 * is asked for at checkout. Every price is set here, from the catalogue —
 * nothing the browser sends carries a price.
 */

type Failure = { error: string }
const FAILED = 'Something went wrong updating your cart. Please try again.'

export const addToCart = actionClient
  .inputSchema(z.object({ domain: z.string().min(3).max(253) }))
  .action(async ({ parsedInput }): Promise<Failure | { count: number }> => {
    const { stem, tld, isValid } = parseSearchQuery(parsedInput.domain)
    if (!isValid || !tld) return { error: 'That is not a domain we can add.' }
    const domain = `${stem}.${tld}`

    const priced = await getPricedCatalogue()
    if (!priced) return { error: 'Prices are unavailable right now, so nothing can be added.' }
    const pricing = priced.tlds.find((candidate) => candidate.tld === tld)
    if (!pricing) return { error: `We don't sell .${tld}.` }

    // The search may be minutes old, and its answer cached (FR-S6): ask the
    // registry again. Never put a name in a cart that cannot be bought
    // (checkout checks again, FR-C7).
    const availability = await checkAvailability([stem], [tld], 'high', { fresh: true })
    if (!availability.ok)
      return { error: "We couldn't confirm it's still free. Try again in a moment." }
    if (availability.results[0]?.status !== 'available') {
      return { error: `${domain} was taken while you were looking.` }
    }

    try {
      const cartId = await findOrCreateCartId(await ownerForWrite())
      const count = await countLines(cartId)
      if (count >= MAX_CART_ITEMS) {
        return { error: `A cart holds up to ${MAX_CART_ITEMS} domains. Check out these first.` }
      }

      // The shortest term the registry sells — one year, or two for .ai (FR-C2).
      const years = pricing.firstTerm.years
      const quote = quoteFor(pricing, years)
      await insertLine(cartId, {
        domain,
        tld,
        periodYears: years,
        quotedTotalKobo: quote.totalKobo,
        quotedRenewalKobo: quote.renewalKobo,
        quotedFxRateId: priced.rateId,
      })

      countCartAdd()

      const after = await countLines(cartId)
      await setCountCookie(after)
      return { count: after }
    } catch (err) {
      logger.error({ err }, 'add to cart failed')
      return { error: FAILED }
    }
  })

/** A name "add all" could not add, and why — in words for the page. */
export type NotAdded = { domain: string; reason: string }

/**
 * "Add selected to cart" from a bulk search (FR-S5). Every name is re-checked
 * with the registry first, past its cache (FR-S6), like a single add —
 * grouped into as few gateway requests as the search itself used, and at
 * normal priority, so a bulk add never jumps ahead of someone waiting on
 * their exact match (PRD V4). Only names the person ticked are sent; nothing
 * is ticked for them (N9). A cart holds MAX_CART_ITEMS lines, so no more are
 * accepted, and names past the room left are never re-checked.
 */
export const addDomainsToCart = actionClient
  .inputSchema(
    z.object({
      domains: z.array(z.string().min(3).max(253)).min(1).max(MAX_CART_ITEMS),
    }),
  )
  .action(
    async ({
      parsedInput,
    }): Promise<Failure | { count: number; added: string[]; notAdded: NotAdded[] }> => {
      if (!(await withinLimit(await addressKey('bulk_add'), LIMITS.bulkAddToCart))) {
        return { error: "You've added a lot in the last few minutes. Wait a little and try again." }
      }
      const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])
      if (!priced) return { error: 'Prices are unavailable right now, so nothing can be added.' }
      const byTld = new Map(priced.tlds.map((tld) => [tld.tld, tld]))

      const notAdded: NotAdded[] = []
      const wanted: { name: string; tld: string; domain: string; pricing: TldPricing }[] = []
      for (const raw of new Set(parsedInput.domains)) {
        const { stem, tld, isValid } = parseSearchQuery(raw)
        const shown = toUnicodeHost(raw.toLowerCase())
        if (!isValid || !tld) {
          notAdded.push({ domain: shown, reason: 'Not a domain we can add' })
          continue
        }
        const pricing = byTld.get(tld)
        if (!pricing) {
          notAdded.push({ domain: shown, reason: `We don't sell .${toUnicodeHost(tld)}` })
          continue
        }
        // FR-S9: a name the extension refuses is never sent to the supplier.
        const issue = lengthIssue(stem, lengthRules[tld])
        if (issue) {
          notAdded.push({ domain: shown, reason: describeLengthIssue(issue, stem, tld) })
          continue
        }
        if (!wanted.some((entry) => entry.domain === `${stem}.${tld}`)) {
          wanted.push({ name: stem, tld, domain: `${stem}.${tld}`, pricing })
        }
      }

      try {
        const cartId = await findOrCreateCartId(await ownerForWrite())
        const inCart = new Set((await loadLines(cartId)).map((line) => line.domain))
        let count = inCart.size

        // Only as many as the cart has room for are worth asking the registry about.
        const room = Math.max(0, MAX_CART_ITEMS - count)
        const toCheck = wanted.filter((entry) => !inCart.has(entry.domain)).slice(0, room)
        const asked = new Set(toCheck.map((entry) => entry.domain))
        const outcomes = await Promise.all(
          packChecks(
            toCheck.map((entry) => ({ ...entry, issue: null })),
            lengthRules,
          ).map((chunk) => checkAvailability(chunk.names, chunk.tlds, 'normal', { fresh: true })),
        )
        const statusOf = new Map(
          outcomes.flatMap((outcome) =>
            outcome.ok
              ? outcome.results.map((result) => [result.domain, result.status] as const)
              : [],
          ),
        )
        const added: string[] = []
        let putInCart = false

        for (const entry of wanted) {
          const shown = toUnicodeHost(entry.domain)
          const status = statusOf.get(entry.domain)
          if (inCart.has(entry.domain)) {
            added.push(shown)
            continue
          }
          if (!asked.has(entry.domain) || count >= MAX_CART_ITEMS) {
            notAdded.push({ domain: shown, reason: `A cart holds up to ${MAX_CART_ITEMS} domains` })
            continue
          }
          if (status === undefined || status === 'unknown') {
            notAdded.push({ domain: shown, reason: "We couldn't confirm it's still free" })
            continue
          }
          if (status !== 'available') {
            notAdded.push({ domain: shown, reason: 'Taken while you were looking' })
            continue
          }

          const years = entry.pricing.firstTerm.years
          const quote = quoteFor(entry.pricing, years)
          await insertLine(cartId, {
            domain: entry.domain,
            tld: entry.tld,
            periodYears: years,
            quotedTotalKobo: quote.totalKobo,
            quotedRenewalKobo: quote.renewalKobo,
            quotedFxRateId: priced.rateId,
          })
          count += 1
          added.push(shown)
          putInCart = true
        }
        // One add, however many names it put in the cart.
        if (putInCart) countCartAdd()

        const after = await countLines(cartId)
        await setCountCookie(after)
        return { count: after, added, notAdded }
      } catch (err) {
        logger.error({ err }, 'bulk add to cart failed')
        return { error: FAILED }
      }
    },
  )

export const updateCartLine = actionClient
  .inputSchema(
    z.object({
      lineId: z.uuid(),
      periodYears: z.number().int().min(1).max(10).optional(),
      privacy: z.boolean().optional(),
      autoRenew: z.boolean().optional(),
    }),
  )
  .action(async ({ parsedInput }): Promise<Failure | { ok: true }> => {
    try {
      const cartId = await existingCartId()
      if (!cartId) return { error: FAILED }
      const line = (await loadLines(cartId)).find(
        (candidate) => candidate.id === parsedInput.lineId,
      )
      if (!line) return { error: 'That domain is no longer in your cart.' }

      const patch: Parameters<typeof updateLine>[2] = {}
      if (parsedInput.privacy !== undefined) patch.privacy = parsedInput.privacy
      if (parsedInput.autoRenew !== undefined) patch.auto_renew = parsedInput.autoRenew

      if (parsedInput.periodYears !== undefined && parsedInput.periodYears !== line.periodYears) {
        const priced = await getPricedCatalogue()
        const pricing = priced?.tlds.find((candidate) => candidate.tld === line.tld)
        if (!priced || !pricing) return { error: `We no longer sell .${line.tld}.` }
        // Only a period the registry sells has a true price (FR-C2, N9b).
        if (!sellsPeriod(pricing, parsedInput.periodYears)) {
          return {
            error: `.${line.tld} can be registered for ${periodsText(pricing.registerPeriods)}.`,
          }
        }
        // A new period is a new quote, at today's price, with a fresh lock.
        const years = parsedInput.periodYears
        const quote = quoteFor(pricing, years)
        Object.assign(patch, {
          period_years: years,
          quoted_total_kobo: quote.totalKobo,
          quoted_renewal_kobo: quote.renewalKobo,
          quoted_fx_rate_id: priced.rateId,
          quoted_at: new Date().toISOString(),
        })
      }

      await updateLine(cartId, line.id, patch)
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'cart update failed')
      return { error: FAILED }
    }
  })

export const removeCartLine = actionClient
  .inputSchema(z.object({ lineId: z.uuid() }))
  .action(async ({ parsedInput }): Promise<Failure | { count: number }> => {
    try {
      const cartId = await existingCartId()
      if (!cartId) return { count: 0 }
      await deleteLine(cartId, parsedInput.lineId)
      const count = await countLines(cartId)
      await setCountCookie(count)
      return { count }
    } catch (err) {
      logger.error({ err }, 'cart remove failed')
      return { error: FAILED }
    }
  })

/** FR-C4 — the customer has seen the new prices and accepts them. */
export const acceptCurrentPrices = actionClient.action(
  async (): Promise<Failure | { ok: true }> => {
    try {
      const cartId = await existingCartId()
      const priced = await getPricedCatalogue()
      if (!cartId || !priced) return { error: FAILED }

      const byTld = new Map(priced.tlds.map((tld) => [tld.tld, tld]))
      const now = new Date().toISOString()
      // SSL certificates (FR-SSL-6) are re-quoted at today's price too.
      const sslLines = await loadSslLines(cartId)
      if (sslLines.length > 0) {
        const ssl = await getSslCatalogue()
        if (!ssl) return { error: FAILED }
        const byCode = new Map(ssl.products.map((product) => [product.productCode, product]))
        for (const line of sslLines) {
          const product = byCode.get(line.productCode)
          if (!product) continue
          await requoteSslLine(cartId, line.id, {
            quoted_total_kobo: product.price.priceKobo,
            quoted_fx_rate_id: ssl.rateId,
            quoted_at: now,
          })
        }
      }
      for (const line of await loadLines(cartId)) {
        const pricing = byTld.get(line.tld)
        if (!pricing) continue
        // A period the registry stopped selling moves to the one the cart
        // showed in its place (priceLine), and that is the price accepted.
        const years = sellsPeriod(pricing, line.periodYears)
          ? line.periodYears
          : nearestSoldPeriod(line.periodYears, pricing)
        const quote = quoteFor(pricing, years)
        await updateLine(cartId, line.id, {
          period_years: years,
          quoted_total_kobo: quote.totalKobo,
          quoted_renewal_kobo: quote.renewalKobo,
          quoted_fx_rate_id: priced.rateId,
          quoted_at: now,
        })
      }
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'accept prices failed')
      return { error: FAILED }
    }
  },
)

/**
 * ADMIN-SPEC §6: one `cart_add` in the funnel, on the side checkout would be
 * paid on. Searches are never counted (FR-S7). Counted once the response has
 * gone (`after`), and a count that fails never fails the add.
 */
function countCartAdd() {
  const failed = (code?: string) => logger.warn({ code }, 'cart add not counted')
  try {
    afterResponse(async () => {
      try {
        const { testMode } = requirePaymentEnv()
        const { error } = await createServiceClient().rpc('bump_funnel', {
          p_event: 'cart_add',
          p_test_mode: testMode,
        })
        if (error) failed(error.code)
      } catch {
        failed()
      }
    })
  } catch {
    failed()
  }
}
