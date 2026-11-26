import 'server-only'

import { type AiAnswer, type AiFeature, type AiSettings, aiUsageArgs } from '@dr/shared/ai'
import { after as afterResponse } from 'next/server'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

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

/**
 * Counts one call in `ai_usage` (AI phase 4, migration 75): the feature, the
 * model, how it went and the tokens billed — never the prompt or the answer
 * (N13). Counted once the response has gone, so nobody waits for it, and a
 * count that fails never fails the feature. `declined`: the model answered
 * but could not help.
 */
export function noteAiUsage(
  feature: AiFeature,
  settings: AiSettings,
  answer: AiAnswer<unknown>,
  declined = false,
): void {
  const args = aiUsageArgs(feature, settings.model ?? 'deepseek-flash', answer, declined)
  const failed = (code?: string) => logger.warn({ feature, code }, 'ai usage not counted')
  try {
    afterResponse(async () => {
      try {
        const { error } = await createServiceClient().rpc('record_ai_usage', args)
        if (error) failed(error.code)
      } catch {
        failed()
      }
    })
  } catch {
    failed()
  }
}
