import 'server-only'

import type { AiSettings } from '@dr/shared/ai'
import { getNameserverPresets } from '@/features/domains/queries/domains'
import { cleanHelpAnswer } from '@/features/legal/lib/help-assistant'
import { priceWords } from '@/features/pricing/lib/price-words'
import { POPULAR_TLDS, toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { parseSearchQuery } from '@/features/search/lib/query'
import { type SearchRow, toSearchRows } from '@/features/search/lib/rows'
import { searchAllowance } from '@/features/search/queries/allowance'
import { checkAvailability } from '@/features/search/queries/availability'
import { nameIdeasFor } from '@/features/search/queries/name-ideas'
import type { AssistantFailure, AssistantReply } from '../lib/conversation'
import { matchPreset, type Route } from '../lib/route'

export type Answered = { ok: true; reply: AssistantReply } | { ok: false; reason: AssistantFailure }

/** The extension a name request falls back on when none was asked for, or the one asked for is not sold. */
const DEFAULT_TLD = 'com'

/**
 * The engine for each route (AI phase 5). Everything shown comes from here:
 * availability from the registry through the gateway (N1), prices from the
 * tables (N5b, N8), nameservers from the checked presets (N11), answers from
 * the help centre (N9b). The model's own words reach the page only as a
 * help answer that passed `cleanHelpAnswer`, or as a name idea's reason.
 */
export async function answerRoute(
  route: Route,
  settings: AiSettings,
  helpSources: ReadonlyMap<string, string>,
): Promise<Answered> {
  switch (route.kind) {
    case 'names':
      return names(route, settings)
    case 'check':
      return check(route.domains)
    case 'prices':
      return prices(route.tlds)
    case 'setup':
      return setup(route.host)
    case 'help':
      return { ok: true, reply: { kind: 'help', help: cleanHelpAnswer(route.answer, helpSources) } }
    case 'other':
      return { ok: true, reply: { kind: 'other' } }
  }
}

async function names(
  route: Extract<Route, { kind: 'names' }>,
  settings: AiSettings,
): Promise<Answered> {
  const priced = await getPricedCatalogue()
  if (!priced) return { ok: false, reason: 'unavailable' }
  const sold = new Set(priced.tlds.map((pricing) => pricing.tld))
  const notSold = route.tld && !sold.has(route.tld) ? route.tld : null
  const tld = route.tld && sold.has(route.tld) ? route.tld : DEFAULT_TLD
  const found = await nameIdeasFor(settings, {
    description: route.description,
    tld,
    language: route.language,
  })
  if (!found.ok) return { ok: false, reason: found.reason }
  return {
    ok: true,
    reply: {
      kind: 'names',
      ideas: found.ideas,
      checked: found.checked,
      tld,
      language: route.language,
      notSold,
    },
  }
}

/**
 * Named domains, checked as a search checks them: counted against the same
 * allowance (SEC-9), so the assistant is no way round the human check — past
 * it, the person is sent to the search page, where the check is.
 */
async function check(domains: readonly string[]): Promise<Answered> {
  const priced = await getPricedCatalogue()
  if (!priced) return { ok: false, reason: 'unavailable' }
  const prices = new Map(priced.tlds.map((pricing) => [pricing.tld, toPublicRow(pricing)]))

  const byTld = new Map<string, string[]>()
  const notSold: string[] = []
  for (const raw of domains) {
    const parsed = parseSearchQuery(raw)
    if (!parsed.isValid) continue
    const tld = parsed.tld ?? DEFAULT_TLD
    if (!prices.has(tld)) {
      notSold.push(`.${tld}`)
      continue
    }
    const stems = byTld.get(tld) ?? []
    if (!stems.includes(parsed.stem)) byTld.set(tld, [...stems, parsed.stem])
  }
  const unsold = [...new Set(notSold)]
  if (byTld.size === 0) {
    return unsold.length > 0
      ? { ok: true, reply: { kind: 'check', rows: [], notSold: unsold } }
      : { ok: true, reply: { kind: 'other' } }
  }

  if ((await searchAllowance()) !== 'ok') {
    const [tld, stems] = [...byTld][0] ?? []
    return { ok: true, reply: { kind: 'search', query: `${stems?.[0]}.${tld}` } }
  }

  const rows: SearchRow[] = []
  for (const [tld, stems] of byTld) {
    const outcome = await checkAvailability(stems, [tld])
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason === 'rate-limited' ? 'busy' : 'unavailable' }
    }
    rows.push(...toSearchRows(outcome.results, prices))
  }
  return { ok: true, reply: { kind: 'check', rows, notSold: unsold } }
}

async function prices(asked: readonly string[]): Promise<Answered> {
  const priced = await getPricedCatalogue()
  if (!priced) return { ok: false, reason: 'unavailable' }
  const byTld = new Map(priced.tlds.map((pricing) => [pricing.tld, pricing]))
  const tlds = asked.length > 0 ? asked : [...POPULAR_TLDS]
  return {
    ok: true,
    reply: {
      kind: 'prices',
      prices: tlds.flatMap((tld) => {
        const pricing = byTld.get(tld)
        return pricing ? [{ tld, words: priceWords(pricing) }] : []
      }),
      // The popular list may hold a paused extension; only a named one is "not sold".
      notSold: asked.filter((tld) => !byTld.has(tld)).map((tld) => `.${tld}`),
      vatPct: priced.vatPct,
    },
  }
}

async function setup(host: string | null): Promise<Answered> {
  const presets = await getNameserverPresets()
  const preset = matchPreset(
    host,
    presets.map(({ provider, nameservers, assignsPerZone, sourceUrl }) => ({
      provider,
      nameservers,
      assignsPerZone,
      sourceUrl,
    })),
  )
  return { ok: true, reply: { kind: 'setup', host, preset } }
}
