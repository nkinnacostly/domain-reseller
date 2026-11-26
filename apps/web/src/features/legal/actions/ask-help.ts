'use server'

import { askForJson, redactContactDetails } from '@dr/shared/ai'
import { z } from 'zod'
import { aiSettings, noteAiUsage } from '@/lib/ai'
import { BUSINESS } from '@/lib/business'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { actionClient } from '@/lib/safe-action'
import {
  cleanHelpAnswer,
  type HelpAnswer,
  helpAnswerRequest,
  helpAnswerSchema,
  QUESTION_MAX,
  QUESTION_MIN,
} from '../lib/help-assistant'
import { helpMaterial } from '../queries/help-material'

export type AskHelpResult =
  | { ok: true; help: HelpAnswer }
  | { ok: false; reason: 'off' | 'limited' | 'unavailable' }

/**
 * The help assistant's one request (feature 4): a question, answered from the
 * help centre only, with the pages it used. The question goes to DeepSeek
 * with email addresses and phone numbers taken out, and nothing about the
 * person; neither it nor the answer is logged (N13). Twenty per address in
 * ten minutes.
 */
export const askHelp = actionClient
  .inputSchema(z.object({ question: z.string().trim().min(QUESTION_MIN).max(QUESTION_MAX) }))
  .action(async ({ parsedInput }): Promise<AskHelpResult> => {
    const settings = aiSettings()
    if (!settings) return { ok: false, reason: 'off' }
    if (!(await withinLimit(await addressKey('help_answers'), LIMITS.helpAnswers))) {
      return { ok: false, reason: 'limited' }
    }

    const { corpus, sources } = helpMaterial()
    const answer = await askForJson(
      settings,
      helpAnswerRequest(corpus, redactContactDetails(parsedInput.question), BUSINESS.email),
      helpAnswerSchema,
    )
    if (!answer.ok) {
      noteAiUsage('help_answer', settings, answer)
      logger.warn({ reason: answer.reason, status: answer.status }, 'help answer: no answer')
      return { ok: false, reason: 'unavailable' }
    }
    const help = cleanHelpAnswer(answer.value, sources)
    noteAiUsage('help_answer', settings, answer, !help.answered)
    logger.info(
      {
        answered: help.answered,
        promptTokens: answer.usage.promptTokens,
        cachedTokens: answer.usage.cachedTokens,
        completionTokens: answer.usage.completionTokens,
      },
      'help answer',
    )
    return { ok: true, help }
  })
