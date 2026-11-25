import 'server-only'

import type { AiSettings } from '@dr/shared/ai'
import { env } from '@/lib/env'

/**
 * The AI features' one switch: on while DEEPSEEK_API_KEY is set. Off, each
 * feature says so and the rest of the site is unchanged; the privacy notice
 * names DeepSeek only while it is on (N9b).
 *
 * DeepSeek's own API keeps what it is sent in China, so callers send it no
 * personal data: no account, contact or payment detail, and a person's typed
 * text only after `redactContactDetails` (NDPA, CMP-11).
 */
export function isAiEnabled(): boolean {
  return Boolean(env.DEEPSEEK_API_KEY)
}

/** Settings for a customer-facing call: the fast model, the shared timeout. */
export function aiSettings(): AiSettings | null {
  return env.DEEPSEEK_API_KEY ? { apiKey: env.DEEPSEEK_API_KEY, model: 'deepseek-flash' } : null
}
