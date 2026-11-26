import type { AiAnswer, DeepSeekModel } from './deepseek'

/**
 * What each AI call cost, as counts (AI phase 4, migration 75). Every feature
 * that asks a model records one call with `record_ai_usage`: the feature, the
 * model, how it went and the tokens DeepSeek billed — never the prompt, the
 * answer or a name (N13, FR-S7). The database prices the tokens from
 * `ai_model_rates`, so the AI page and the budget alert read one estimate.
 */

/** Migration 75's `ai_usage.feature` check lists exactly these (a test holds them together). */
export const AI_FEATURES = [
  'name_finder',
  'name_ideas_overnight',
  'setup_help',
  'help_answer',
  'alert_help',
  'portfolio_copilot',
  'order_screening',
] as const

export type AiFeature = (typeof AI_FEATURES)[number]

/** `failed`: no usable answer. `declined`: an answer that could not help (a help question the pages do not cover). */
export type AiOutcome = 'ok' | 'failed' | 'declined'

export type AiUsageArgs = {
  p_feature: AiFeature
  p_model: DeepSeekModel
  p_outcome: AiOutcome
  p_prompt_tokens: number
  p_cached_tokens: number
  p_completion_tokens: number
}

/** One call, as `record_ai_usage` takes it. A failure DeepSeek billed nothing for counts no tokens. */
export function aiUsageArgs(
  feature: AiFeature,
  model: DeepSeekModel,
  answer: AiAnswer<unknown>,
  declined = false,
): AiUsageArgs {
  const usage = answer.usage
  return {
    p_feature: feature,
    p_model: model,
    p_outcome: !answer.ok ? 'failed' : declined ? 'declined' : 'ok',
    p_prompt_tokens: usage?.promptTokens ?? 0,
    p_cached_tokens: usage?.cachedTokens ?? 0,
    p_completion_tokens: usage?.completionTokens ?? 0,
  }
}
