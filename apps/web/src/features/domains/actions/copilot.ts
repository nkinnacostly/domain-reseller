'use server'

import {
  askForJson,
  maskInstruction,
  portfolioIntentAnswer,
  portfolioIntentRequest,
  toPortfolioIntent,
} from '@dr/shared/ai'
import { z } from 'zod'
import { aiSettings } from '@/lib/ai'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { type CopilotDraft, resolveIntent } from '../lib/copilot'
import { getNameserverPresets, getPortfolio } from '../queries/domains'
import { getLabels } from '../queries/labels'

export type CopilotResult =
  | { ok: true; draft: CopilotDraft }
  /** `off` — no AI key; `limited` — asked too often; `unavailable` — the model could not answer. */
  | { ok: false; reason: 'off' | 'limited' | 'unavailable' }

/**
 * The portfolio copilot (feature 7): a typed instruction becomes a draft.
 * The model is sent the words — domain names, emails and phone numbers
 * masked — and the public names of the hosts we have presets for; never the
 * account's domains, labels or statuses. Our code resolves its intent
 * against the account (read as the customer, under RLS) into a draft, which
 * changes nothing: the customer confirms it through the bulk actions, which
 * check everything again. Neither the words nor the answer are logged (N13).
 */
export const draftPortfolioChange = authAction
  .inputSchema(z.object({ instruction: z.string().trim().min(5).max(500) }))
  .action(async ({ parsedInput, ctx }): Promise<CopilotResult> => {
    const settings = aiSettings()
    if (!settings) return { ok: false, reason: 'off' }
    if (!(await withinLimit(`portfolio_copilot:user:${ctx.user.id}`, LIMITS.portfolioCopilot))) {
      return { ok: false, reason: 'limited' }
    }

    const [domains, labels, presets] = await Promise.all([
      getPortfolio(),
      getLabels(),
      getNameserverPresets(),
    ])
    const masked = maskInstruction(parsedInput.instruction)
    const answer = await askForJson(
      settings,
      portfolioIntentRequest(
        masked.text,
        presets.map((preset) => preset.provider),
      ),
      portfolioIntentAnswer,
    )
    if (!answer.ok) {
      logger.warn({ reason: answer.reason, status: answer.status }, 'portfolio copilot: no answer')
      return { ok: false, reason: 'unavailable' }
    }
    const draft = resolveIntent(
      toPortfolioIntent(answer.value, masked.names),
      { domains, labels: labels ?? [] },
      presets,
      new Date(),
    )
    logger.info(
      {
        kind: draft.kind,
        action: draft.kind === 'draft' ? draft.action : null,
        count: draft.kind === 'draft' ? draft.domains.length : 0,
        promptTokens: answer.usage.promptTokens,
        completionTokens: answer.usage.completionTokens,
      },
      'portfolio copilot',
    )
    return { ok: true, draft }
  })
