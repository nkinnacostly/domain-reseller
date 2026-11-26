import { describe, expect, it, vi } from 'vitest'
import { countingAsk } from './ai-usage'

const request = { system: 'Reply in json.', user: 'paypal-login.com', maxTokens: 100 }
const usage = { promptTokens: 300, cachedTokens: 256, completionTokens: 40 }

function client(result: { error: { code: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  return { rpc } as never as Parameters<typeof countingAsk>[3] & { rpc: typeof rpc }
}

describe('countingAsk (AI phase 4)', () => {
  it('counts each call as counts only, and hands the answer back unchanged', async () => {
    const db = client({ error: null })
    const answer = { ok: true as const, value: { verdict: 'review' }, usage }
    const ask = countingAsk(async () => answer, 'order_screening', 'deepseek-flash', db, {
      warn: vi.fn(),
    })
    expect(await ask(request)).toBe(answer)
    expect(db.rpc).toHaveBeenCalledWith('record_ai_usage', {
      p_feature: 'order_screening',
      p_model: 'deepseek-flash',
      p_outcome: 'ok',
      p_prompt_tokens: 300,
      p_cached_tokens: 256,
      p_completion_tokens: 40,
    })
    expect(JSON.stringify(db.rpc.mock.calls)).not.toContain('paypal')
  })

  it('never fails the job when the count cannot be written', async () => {
    const warn = vi.fn()
    const failed = { ok: false as const, reason: 'timeout' as const }
    const refused = countingAsk(
      async () => failed,
      'name_ideas_overnight',
      'deepseek-v4-pro',
      client({ error: { code: '42501' } }),
      { warn },
    )
    expect(await refused(request)).toBe(failed)
    const down = countingAsk(
      async () => failed,
      'name_ideas_overnight',
      'deepseek-v4-pro',
      client(new Error('down')),
      { warn },
    )
    expect(await down(request)).toBe(failed)
    expect(warn).toHaveBeenCalledWith(
      { feature: 'name_ideas_overnight', code: '42501' },
      'ai usage not counted',
    )
    expect(warn).toHaveBeenCalledWith({ feature: 'name_ideas_overnight' }, 'ai usage not counted')
  })
})
