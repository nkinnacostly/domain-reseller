'use server'

import { askForJson } from '@dr/shared/ai'
import { z } from 'zod'
import { aiSettings, noteAiUsage } from '@/lib/ai'
import { BUSINESS } from '@/lib/business'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import {
  cleanSetupHelp,
  type SetupHelp,
  setupFacts,
  setupHelpAnswer,
  setupHelpRequest,
} from '../lib/setup-help'
import { delegationViews } from '../queries/dns'
import { getDomain, getNameserverHistory, getNameserverPresets } from '../queries/domains'

export type SetupHelpResult =
  | { ok: true; help: SetupHelp }
  /** `off` — no AI key; `limited` — asked too often; `unavailable` — the model could not answer. */
  | { ok: false; reason: 'off' | 'not_found' | 'limited' | 'unavailable' }

/**
 * "Explain what's happening" on a domain's Nameservers tab (feature 3).
 * Asked for, never run on its own: the facts are read live (FR-D6) and
 * worded by the model, which is sent no domain name and nothing about the
 * person. The domain is read as the customer, so RLS answers "not yours"
 * as "not found". Nothing the model says is logged (N13).
 */
export const explainSetup = authAction
  .inputSchema(z.object({ domain: z.string().trim().min(3).max(253) }))
  .action(async ({ parsedInput, ctx }): Promise<SetupHelpResult> => {
    const settings = aiSettings()
    if (!settings) return { ok: false, reason: 'off' }

    const domain = await getDomain(parsedInput.domain)
    if (!domain) return { ok: false, reason: 'not_found' }

    if (!(await withinLimit(`setup_help:user:${ctx.user.id}`, LIMITS.setupHelp))) {
      return { ok: false, reason: 'limited' }
    }

    const [views, history, presets] = await Promise.all([
      delegationViews(domain.domainName),
      getNameserverHistory(domain.id),
      getNameserverPresets(),
    ])
    const facts = setupFacts({
      domain: domain.domainName,
      requested: domain.pendingNameservers ?? domain.nameservers,
      changeWaiting: domain.pendingNameservers !== null,
      delegation: domain.delegationStatus,
      onHold: Boolean(domain.onHold),
      host: presets.find((preset) => preset.id === domain.presetId)?.provider ?? null,
      lastChangedAt: history?.[0]?.changedAt ?? null,
      views,
      now: new Date(),
    })

    const answer = await askForJson(
      settings,
      setupHelpRequest(facts, BUSINESS.email),
      setupHelpAnswer,
    )
    noteAiUsage('setup_help', settings, answer)
    if (!answer.ok) {
      logger.warn({ reason: answer.reason, status: answer.status }, 'setup help: no answer')
      return { ok: false, reason: 'unavailable' }
    }
    logger.info(
      {
        promptTokens: answer.usage.promptTokens,
        cachedTokens: answer.usage.cachedTokens,
        completionTokens: answer.usage.completionTokens,
      },
      'setup help',
    )
    return { ok: true, help: cleanSetupHelp(answer.value) }
  })
