import 'server-only'

import { formatNaira } from '@dr/shared'
import { headers } from 'next/headers'
import { cartAddHref, MAX_LINK_DOMAINS } from '@/features/cart/lib/add-link'
import { priceOf, priceWords } from '@/features/pricing/lib/price-words'
import { POPULAR_TLDS } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { toUnicodeHost } from '@/features/search/lib/idn'
import { planSearch, stemIssue } from '@/features/search/lib/plan'
import { describeProblem, parseSearchQuery } from '@/features/search/lib/query'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { clientAddress } from '@/lib/client-ip'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { isAnthropicAddress, isOpenAiAddress } from '../lib/addresses'
import type { McpTool, ToolResult } from '../lib/protocol'
import {
  CART_LINK_SCHEMA,
  cartLinkInput,
  inputProblem,
  PRICES_SCHEMA,
  pricesInput,
  SEARCH_SCHEMA,
  searchInput,
  VAT_NOTE,
} from '../lib/tools'
import { openAiPrefixes } from './openai-ranges'

/**
 * The MCP tools at work (feature 8). Prices come from the tables, never from
 * anything an assistant sends (N5b, N8); availability from the gateway (N1)
 * at normal priority, inside per-address and all-assistant limits, because
 * every search shares the supplier's two requests a second. Searches are
 * never logged (FR-S7): log lines carry the tool and its outcome only.
 */

const UNPRICED: ToolResult = {
  text: 'Prices are briefly unavailable, so nothing can be quoted. Try again in a few minutes.',
  isError: true,
}
const BUSY: ToolResult = {
  text: 'Too many searches just now. Wait a minute, then try again.',
  isError: true,
}

const absolute = (path: string) => new URL(path, env.NEXT_PUBLIC_APP_URL).toString()

/**
 * The bucket a request draws on: Claude's users all arrive from Anthropic's
 * range and ChatGPT's from OpenAI's published list, so each assistant gets one
 * larger bucket; anyone else is limited per address.
 */
async function callBucket(): Promise<{
  key: string
  limit: { max: number; windowSeconds: number }
}> {
  const address = clientAddress(await headers())
  if (isAnthropicAddress(address)) return { key: 'mcp:anthropic', limit: LIMITS.mcpClaudeCalls }
  if (isOpenAiAddress(address, await openAiPrefixes())) {
    return { key: 'mcp:openai', limit: LIMITS.mcpOpenAiCalls }
  }
  return { key: await addressKey('mcp'), limit: LIMITS.mcpCalls }
}

async function limited(scope: 'calls' | 'search'): Promise<boolean> {
  const bucket = await callBucket()
  if (!(await withinLimit(bucket.key, bucket.limit))) return true
  if (scope === 'search' && !(await withinLimit('mcp_search:all', LIMITS.mcpSearchAll))) return true
  return false
}

export async function searchDomains(args: Record<string, unknown>): Promise<ToolResult> {
  const input = searchInput.safeParse(args)
  if (!input.success) return { text: inputProblem(input.error), isError: true }
  const parsed = parseSearchQuery(input.data.query)
  if (!parsed.isValid) {
    return {
      text: parsed.problem ? describeProblem(parsed.problem) : 'That is not a name we can search.',
      isError: true,
    }
  }
  if (await limited('search')) return BUSY

  const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])
  if (!priced) return UNPRICED
  const byTld = new Map(priced.tlds.map((pricing) => [pricing.tld, pricing]))
  const plan = planSearch({
    stem: parsed.stem,
    tld: parsed.tld,
    sold: new Set(byTld.keys()),
    featured: priced.featured.map((pricing) => pricing.tld),
    lengthRules,
  })
  const tlds = plan.gridTlds.filter((tld) => !stemIssue(plan, tld))
  if (tlds.length === 0) {
    return {
      text: `“${input.data.query}” can't be registered with the extensions we sell.`,
      isError: true,
    }
  }
  const outcome = await checkAvailability([plan.stem], tlds, 'normal')
  if (!outcome.ok) {
    logger.info({ tool: 'search_domains', outcome: outcome.reason }, 'mcp tool')
    return outcome.reason === 'rate-limited'
      ? BUSY
      : { text: "We couldn't reach the registry just now. Try again in a minute.", isError: true }
  }

  const results = outcome.results.map((row) => {
    const pricing = byTld.get(row.tld)
    const available = row.status === 'available' && pricing !== undefined
    return {
      domain: toUnicodeHost(row.domain),
      status: row.status,
      ...(available && pricing ? { price: priceOf(pricing), words: priceWords(pricing) } : {}),
    }
  })
  const free = results.filter((row) => 'words' in row)
  const lines = results.map((row) =>
    'words' in row
      ? `- ${row.domain}: available — ${row.words}`
      : `- ${row.domain}: ${row.status === 'registered' ? 'taken' : row.status === 'premium' ? 'premium, not sold here' : 'could not be checked'}`,
  )
  logger.info(
    { tool: 'search_domains', outcome: 'ok', checked: results.length, free: free.length },
    'mcp tool',
  )
  return {
    text: [
      ...(plan.unsoldTld
        ? [`We don't sell .${plan.unsoldTld}; here are the extensions we do.`]
        : []),
      ...lines,
      '',
      VAT_NOTE(priced.vatPct),
    ].join('\n'),
    structured: {
      results: results.map(({ words: _words, ...row }) => row),
      ...(plan.unsoldTld ? { notSold: plan.unsoldTld } : {}),
      vatPct: priced.vatPct,
    },
  }
}

export async function getPrices(args: Record<string, unknown>): Promise<ToolResult> {
  const input = pricesInput.safeParse(args)
  if (!input.success) return { text: inputProblem(input.error), isError: true }
  if (await limited('calls')) return BUSY
  const priced: PricedCatalogue | null = await getPricedCatalogue()
  if (!priced) return UNPRICED
  const byTld = new Map(priced.tlds.map((pricing) => [pricing.tld, pricing]))
  const asked = (input.data.extensions ?? [...POPULAR_TLDS]).map((tld) =>
    tld.replace(/^\./, '').toLowerCase(),
  )
  const found = asked.flatMap((tld) => {
    const pricing = byTld.get(tld)
    return pricing ? [pricing] : []
  })
  const missing = asked.filter((tld) => !byTld.has(tld))
  const lines = found.map((pricing) => {
    const transfer = pricing.transfer
      ? `; transfer in ${formatNaira(pricing.transfer.priceKobo)}`
      : ''
    return `- .${pricing.tld}: ${priceWords(pricing)}${transfer}`
  })
  return {
    text: [
      ...lines,
      ...(missing.length > 0 && input.data.extensions
        ? [`Not sold here: ${missing.map((tld) => `.${tld}`).join(', ')}`]
        : []),
      '',
      VAT_NOTE(priced.vatPct),
    ]
      .join('\n')
      .trim(),
    structured: {
      prices: found.map((pricing) => ({
        extension: pricing.tld,
        ...priceOf(pricing),
        transfer: pricing.transfer ? formatNaira(pricing.transfer.priceKobo) : null,
      })),
      vatPct: priced.vatPct,
    },
  }
}

export async function createCartLink(args: Record<string, unknown>): Promise<ToolResult> {
  const input = cartLinkInput.safeParse(args)
  if (!input.success) return { text: inputProblem(input.error), isError: true }
  if (await limited('calls')) return BUSY
  const priced = await getPricedCatalogue()
  if (!priced) return UNPRICED
  const sold = new Set(priced.tlds.map((pricing) => pricing.tld))
  const names: string[] = []
  const refused: string[] = []
  for (const raw of input.data.domains) {
    const { stem, tld, isValid } = parseSearchQuery(raw)
    if (isValid && tld && sold.has(tld)) names.push(`${stem}.${tld}`)
    else refused.push(raw)
  }
  const unique = [...new Set(names)].slice(0, MAX_LINK_DOMAINS)
  if (unique.length === 0) {
    return {
      text: 'None of those are domains we sell. Search first with search_domains.',
      isError: true,
    }
  }
  const url = absolute(cartAddHref(unique))
  return {
    text: [
      `Give the person this link: ${url}`,
      'They see each name with its price and renewal price, add them to their cart, and pay on mydomainshub.com. Nothing is added or charged until they do; each name is checked again when added.',
      ...(refused.length > 0 ? [`Left out (not a domain we sell): ${refused.join(', ')}`] : []),
    ].join('\n'),
    structured: { url, domains: unique.map(toUnicodeHost), leftOut: refused },
  }
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'search_domains',
    title: 'Search domain names',
    description:
      'Check whether a domain name is free at MyDomainsHub (Nigeria), with its naira price and renewal price. Checks the extension asked for and popular ones.',
    inputSchema: SEARCH_SCHEMA,
    annotations: {
      title: 'Search domain names',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: searchDomains,
  },
  {
    name: 'get_prices',
    title: 'Domain prices',
    description:
      'Naira prices to register, renew and transfer in domain extensions at MyDomainsHub, before VAT.',
    inputSchema: PRICES_SCHEMA,
    annotations: {
      title: 'Domain prices',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: getPrices,
  },
  {
    name: 'create_cart_link',
    title: 'Link to buy',
    description:
      'A mydomainshub.com link where the person adds the chosen domains to their cart and pays. Nothing is added or charged until they open it and confirm.',
    inputSchema: CART_LINK_SCHEMA,
    annotations: {
      title: 'Link to buy',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: createCartLink,
  },
]

/**
 * The tools ChatGPT is offered at /mcp/chatgpt (AI phase 5): search and
 * prices only. OpenAI's plugin rules (5.1) forbid linking straight to a
 * checkout, which `create_cart_link` does.
 */
export const MCP_TOOLS_READ_ONLY: McpTool[] = MCP_TOOLS.filter(
  (tool) => tool.name !== 'create_cart_link',
)
