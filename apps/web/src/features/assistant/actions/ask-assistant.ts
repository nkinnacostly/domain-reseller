'use server'

import { askForJson, redactContactDetails } from '@dr/shared/ai'
import { z } from 'zod'
import { helpMaterial } from '@/features/legal/queries/help-material'
import { aiSettings, noteAiUsage } from '@/lib/ai'
import { BUSINESS } from '@/lib/business'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { actionClient } from '@/lib/safe-action'
import {
  type AskAssistantResult,
  HISTORY_MAX,
  MESSAGE_MAX,
  MESSAGE_MIN,
  memoOf,
  TURN_MAX,
} from '../lib/conversation'
import { assistantRequest, readRoute, routeAnswer } from '../lib/route'
import { answerRoute } from '../queries/answer'

const turn = z.object({
  role: z.enum(['person', 'assistant']),
  text: z.string().trim().min(1).max(TURN_MAX),
})

/**
 * The site assistant's one request (AI phase 5): a message and the latest
 * turns in, one answer out. The model is asked what the person wants — and,
 * for a question about us, to answer it from the help centre — then the
 * engine that owns the answer gives it (`answerRoute`).
 *
 * What goes to DeepSeek: the message and the earlier turns, with email
 * addresses and phone numbers taken out, and nothing about the person or the
 * page (NDPA, CMP-11). Public, like search: no account is read. Neither the
 * message nor the answer is logged (N13, FR-S7). Thirty messages per address
 * in ten minutes, and the engines keep their own limits on top.
 */
export const askAssistant = actionClient
  .inputSchema(
    z.object({
      message: z.string().trim().min(MESSAGE_MIN).max(MESSAGE_MAX),
      history: z.array(turn).max(HISTORY_MAX).default([]),
    }),
  )
  .action(async ({ parsedInput }): Promise<AskAssistantResult> => {
    const settings = aiSettings()
    if (!settings) return { ok: false, reason: 'off' }
    if (!(await withinLimit(await addressKey('assistant'), LIMITS.assistant))) {
      return { ok: false, reason: 'limited' }
    }

    const { corpus, sources } = helpMaterial()
    const message = redactContactDetails(parsedInput.message)
    const answer = await askForJson(
      settings,
      assistantRequest(
        corpus,
        parsedInput.history.map((item) => ({
          role: item.role,
          text: redactContactDetails(item.text),
        })),
        message,
        BUSINESS.email,
      ),
      routeAnswer,
    )
    if (!answer.ok) {
      noteAiUsage('site_assistant', settings, answer)
      logger.warn({ reason: answer.reason, status: answer.status }, 'site assistant: no answer')
      return { ok: false, reason: 'unavailable' }
    }

    const route = readRoute(answer.value, message)
    const result = await answerRoute(route, settings, sources)
    const declined =
      result.ok &&
      (result.reply.kind === 'other' ||
        (result.reply.kind === 'help' && !result.reply.help.answered))
    noteAiUsage('site_assistant', settings, answer, declined)
    logger.info(
      {
        route: route.kind,
        outcome: result.ok ? result.reply.kind : result.reason,
        promptTokens: answer.usage.promptTokens,
        cachedTokens: answer.usage.cachedTokens,
        completionTokens: answer.usage.completionTokens,
      },
      'site assistant',
    )
    if (!result.ok) return result
    return { ok: true, reply: result.reply, memo: memoOf(result.reply) }
  })
