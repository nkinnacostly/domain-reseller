import { z } from 'zod'
import { MAX_LINK_DOMAINS } from '@/features/cart/lib/add-link'
import type { JsonSchema } from './protocol'

/**
 * The MCP tools' inputs and words (feature 8). Same prices as everyone: an
 * assistant's customer pays what the site shows (N5b, N8).
 */

export const MAX_PRICE_EXTENSIONS = 20

export const searchInput = z.object({ query: z.string().trim().min(1).max(100) })
export const pricesInput = z.object({
  extensions: z.array(z.string().trim().min(1).max(40)).max(MAX_PRICE_EXTENSIONS).optional(),
})
export const cartLinkInput = z.object({
  domains: z.array(z.string().trim().min(3).max(253)).min(1).max(MAX_LINK_DOMAINS),
})

export const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'A name, with or without an extension: "getpaid" or "getpaid.ng".',
      minLength: 1,
      maxLength: 100,
    },
  },
  required: ['query'],
  additionalProperties: false,
}

export const PRICES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    extensions: {
      type: 'array',
      description:
        'Extensions without the dot, e.g. ["com", "ng"]. Leave out for the popular ones.',
      items: { type: 'string' },
      maxItems: MAX_PRICE_EXTENSIONS,
    },
  },
  additionalProperties: false,
}

export const CART_LINK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    domains: {
      type: 'array',
      description: 'Full domain names the person chose, e.g. ["getpaid.ng"].',
      items: { type: 'string' },
      minItems: 1,
      maxItems: MAX_LINK_DOMAINS,
    },
  },
  required: ['domains'],
  additionalProperties: false,
}

export const VAT_NOTE = (vatPct: number) =>
  `Prices are in naira before VAT (${vatPct}%), which checkout adds as its own line.`

/** The first zod message, for a tool error the assistant can act on. */
export function inputProblem(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue
    ? `Check the input: ${issue.path.join('.') || 'arguments'} — ${issue.message}`
    : 'Check the input.'
}
