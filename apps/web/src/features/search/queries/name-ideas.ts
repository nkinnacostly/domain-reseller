import 'server-only'

import {
  type AiSettings,
  askForJson,
  cleanNameIdeas,
  type NameIdeaLanguage,
  nameIdeasAnswer,
  nameIdeasRequest,
  redactContactDetails,
} from '@dr/shared/ai'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { noteAiUsage } from '@/lib/ai'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { lengthIssue } from '../lib/length'
import { availableIdeas, type NameIdeasResult } from '../lib/name-ideas'
import { toSearchRows } from '../lib/rows'
import { checkAvailability } from './availability'
import { getLengthRules } from './length-rules'

export type NameIdeasAsk = { description: string; tld: string; language: NameIdeaLanguage }

/**
 * The AI name finder's engine, for /ideas and the site assistant alike: the
 * model proposes up to 24 labels for the business described, the gateway
 * checks them on one extension (at most two supplier calls of 20 checks),
 * and only the available ones come back, priced from the catalogue (N5b,
 * N8). AI proposes; the supplier and the tables decide.
 *
 * The description goes to DeepSeek with email addresses and phone numbers
 * taken out, and with nothing else about the person (NDPA, CMP-11). Like a
 * search, neither it nor the names are logged (FR-S7): the log says how many
 * names, how many tokens, and why a request failed. Each call is counted in
 * `ai_usage` as the name finder's (AI phase 4).
 */
export async function nameIdeasFor(
  settings: AiSettings,
  ask: NameIdeasAsk,
): Promise<NameIdeasResult> {
  const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])
  const pricing = priced?.tlds.find((tld) => tld.tld === ask.tld)
  // Without a price nothing can be shown for an available name (N8, N5b).
  if (!priced || !pricing) return { ok: false, reason: 'unavailable' }

  if (!(await withinLimit(await addressKey('name_ideas'), LIMITS.nameIdeas))) {
    return { ok: false, reason: 'limited' }
  }

  const answer = await askForJson(
    settings,
    nameIdeasRequest(
      { kind: 'description', text: redactContactDetails(ask.description) },
      ask.language,
    ),
    nameIdeasAnswer,
  )
  noteAiUsage('name_finder', settings, answer)
  if (!answer.ok) {
    logger.warn({ reason: answer.reason, status: answer.status }, 'name ideas: no answer')
    return { ok: false, reason: 'unavailable' }
  }

  const rule = lengthRules[ask.tld]
  const ideas = cleanNameIdeas(answer.value).filter((idea) => !lengthIssue(idea.label, rule))
  if (ideas.length === 0) return { ok: true, ideas: [], checked: 0 }

  const outcome = await checkAvailability(
    ideas.map((idea) => idea.label),
    [ask.tld],
  )
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason === 'rate-limited' ? 'busy' : 'unavailable' }
  }

  const rows = toSearchRows(outcome.results, new Map([[pricing.tld, toPublicRow(pricing)]]))
  const found = availableIdeas(rows, new Map(ideas.map((idea) => [idea.label, idea.why])))
  logger.info(
    {
      proposed: ideas.length,
      available: found.length,
      promptTokens: answer.usage.promptTokens,
      cachedTokens: answer.usage.cachedTokens,
      completionTokens: answer.usage.completionTokens,
    },
    'name ideas',
  )
  return { ok: true, ideas: found, checked: ideas.length }
}
