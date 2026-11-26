import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { z } from 'zod'
import { logger } from '@/lib/logger'

/**
 * OpenAI's published egress ranges for ChatGPT's plugins and connectors
 * (developers.openai.com, "IP egress ranges"). OpenAI says they change and
 * asks that the list be fetched regularly; it is read once a day here. A
 * read that fails gives no ranges — those requests are then limited per
 * address, as any stranger's are — and is not cached.
 */
export const OPENAI_CONNECTOR_RANGES_URL = 'https://openai.com/chatgpt-connectors.json'

const rangesSchema = z.object({
  prefixes: z
    .array(z.object({ ipv4Prefix: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/) }).loose())
    .max(5000),
})

export async function openAiPrefixes(): Promise<string[]> {
  try {
    return await loadOpenAiPrefixes()
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'openai ranges unavailable',
    )
    return []
  }
}

/** The cached read. Throws on a failed fetch, so a failure is never cached as "no ranges". */
export async function loadOpenAiPrefixes(): Promise<string[]> {
  'use cache'
  cacheTag('openai-ranges')
  cacheLife('days')
  const response = await fetch(OPENAI_CONNECTOR_RANGES_URL, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`openai ranges: HTTP ${response.status}`)
  return rangesSchema.parse(await response.json()).prefixes.map((prefix) => prefix.ipv4Prefix)
}
