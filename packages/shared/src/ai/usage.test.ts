import { describe, expect, it } from 'vitest'
import { aiUsageArgs } from './usage'

const usage = { promptTokens: 900, cachedTokens: 512, completionTokens: 120 }

describe('aiUsageArgs (AI phase 4)', () => {
  it('counts a failure as failed, with only the tokens DeepSeek said it billed', () => {
    expect(aiUsageArgs('help_answer', 'deepseek-flash', { ok: false, reason: 'timeout' })).toEqual({
      p_feature: 'help_answer',
      p_model: 'deepseek-flash',
      p_outcome: 'failed',
      p_prompt_tokens: 0,
      p_cached_tokens: 0,
      p_completion_tokens: 0,
    })
    expect(
      aiUsageArgs('name_finder', 'deepseek-flash', {
        ok: false,
        reason: 'invalid_answer',
        status: 200,
        usage,
      }),
    ).toMatchObject({ p_outcome: 'failed', p_prompt_tokens: 900, p_completion_tokens: 120 })
  })

  it('counts an answer that could not help as declined, and the rest as ok', () => {
    const answer = { ok: true as const, value: {}, usage }
    expect(aiUsageArgs('help_answer', 'deepseek-flash', answer, true).p_outcome).toBe('declined')
    expect(aiUsageArgs('alert_help', 'deepseek-v4-pro', answer)).toEqual({
      p_feature: 'alert_help',
      p_model: 'deepseek-v4-pro',
      p_outcome: 'ok',
      p_prompt_tokens: 900,
      p_cached_tokens: 512,
      p_completion_tokens: 120,
    })
  })
})
