import type { Database } from '@dr/db'
import {
  type AiAnswer,
  type AiFeature,
  type AiRequest,
  aiUsageArgs,
  type DeepSeekModel,
} from '@dr/shared/ai'
import type { SupabaseClient } from '@supabase/supabase-js'

type Log = { warn(fields: object, message: string): void }

/**
 * Counts each of a job's AI calls in `ai_usage` (AI phase 4, migration 75):
 * the feature, the model, how it went and the tokens billed — never the
 * prompt, the answer or a name (N13). A count that fails is logged and never
 * fails the job.
 */
export function countingAsk<T>(
  ask: (request: AiRequest) => Promise<AiAnswer<T>>,
  feature: AiFeature,
  model: DeepSeekModel,
  client: SupabaseClient<Database>,
  log: Log,
): (request: AiRequest) => Promise<AiAnswer<T>> {
  return async (request) => {
    const answer = await ask(request)
    try {
      const { error } = await client.rpc('record_ai_usage', aiUsageArgs(feature, model, answer))
      if (error) log.warn({ feature, code: error.code }, 'ai usage not counted')
    } catch {
      log.warn({ feature }, 'ai usage not counted')
    }
    return answer
  }
}
