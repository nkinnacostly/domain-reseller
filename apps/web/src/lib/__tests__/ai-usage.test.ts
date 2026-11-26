import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_FEATURES } from '@dr/shared/ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADDED_VIA } from '@/features/cart/lib/added-via'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
const later: (() => Promise<void>)[] = []
vi.mock('next/server', () => ({ after: (task: () => Promise<void>) => later.push(task) }))

const { noteAiUsage } = await import('../ai')

const settings = { apiKey: 'sk-test', model: 'deepseek-flash' as const }
const usage = { promptTokens: 700, cachedTokens: 512, completionTokens: 80 }

function rpcAnswers(result: { error: { code: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  return rpc
}

beforeEach(() => {
  vi.clearAllMocks()
  later.length = 0
})

describe('noteAiUsage (AI phase 4)', () => {
  it('counts the call after the response, as counts only', async () => {
    const rpc = rpcAnswers({ error: null })
    noteAiUsage(
      'help_answer',
      settings,
      { ok: true, value: { answer: 'secret words' }, usage },
      true,
    )
    expect(rpc).not.toHaveBeenCalled()
    await Promise.all(later.map((task) => task()))
    expect(rpc).toHaveBeenCalledWith('record_ai_usage', {
      p_feature: 'help_answer',
      p_model: 'deepseek-flash',
      p_outcome: 'declined',
      p_prompt_tokens: 700,
      p_cached_tokens: 512,
      p_completion_tokens: 80,
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('secret words')
  })

  it('never fails the feature when the count cannot be written', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    rpcAnswers({ error: { code: '42501' } })
    noteAiUsage('name_finder', settings, { ok: false, reason: 'timeout' })
    await Promise.all(later.map((task) => task()))
    rpcAnswers(new Error('network down'))
    noteAiUsage('name_finder', settings, { ok: false, reason: 'timeout' })
    await expect(Promise.all(later.map((task) => task()))).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(
      { feature: 'name_finder', code: '42501' },
      'ai usage not counted',
    )
    expect(warn).toHaveBeenCalledWith(
      { feature: 'name_finder', code: undefined },
      'ai usage not counted',
    )
  })
})

describe('the features counted', () => {
  const migration76 = () =>
    readFileSync(
      join(__dirname, '../../../../../supabase/migrations/00000000000076_site_assistant.sql'),
      'utf8',
    )
  const quotedIn = (list: string) =>
    [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort()

  it('are exactly the ones the newest check accepts (migration 76)', () => {
    const listed =
      /add constraint ai_usage_feature_check check \(feature in \(([^)]*)\)\)/.exec(
        migration76(),
      )?.[1] ?? ''
    expect(quotedIn(listed)).toEqual([...AI_FEATURES].sort())
  })

  it('and a cart line takes exactly the sources the cart sends (migration 76)', () => {
    const sql = migration76()
    for (const table of ['cart_items', 'order_items']) {
      const listed =
        new RegExp(
          `add constraint ${table}_added_via_check\\s+check \\(added_via in \\(([^)]*)\\)\\)`,
        ).exec(sql)?.[1] ?? ''
      expect(quotedIn(listed)).toEqual([...ADDED_VIA].sort())
    }
  })
})
