import type { AiFeature } from '@dr/shared/ai'

/**
 * The AI page's words (AI phase 4; docs: "Making AI the core of
 * MyDomainsHub"). Every figure comes from `admin_ai_report`; a measure the
 * product cannot count says so, and says why, rather than showing a guess
 * (N9b).
 */

export const AI_TITLE = 'AI'
export const AI_DESCRIPTION =
  'What the AI features cost, and whether each phase of the AI plan is working. The last 30 days unless a figure says otherwise.'

export const AI_WINDOW_DAYS = 30

export const SPEND_HEADING = 'Spend'
export const SPEND_HIDDEN = 'Not shown to test administrators.'
export const SPEND_EMPTY =
  'No AI calls counted yet. Each call is counted from the day this page went live.'
export const SPEND_ESTIMATE_NOTE =
  "An estimate from the token counts DeepSeek reports, at its listed prices, which double in peak hours. Chinese public holidays count as peak here though DeepSeek bills them off-peak, so on those days it runs a little high. DeepSeek's own dashboard has the exact bill."
export const DAILY_TITLE = 'Estimated AI cost by day, last 30 days (WAT)'
export const FEATURES_CAPTION = 'AI calls by feature, last 30 days'
export const REPORT_ERROR = "The AI figures couldn't be loaded."

/** "This month: $1.24 of a $50.00 budget." */
export function budgetWords(spent: string, budget: string): string {
  return `${spent} of the ${budget} monthly budget. An alert is raised past it.`
}

export const BUDGET_LINK = 'Change the budget in Settings'

export const FEATURE_LABEL: Readonly<Record<AiFeature, string>> = {
  name_finder: 'Name finder',
  name_ideas_overnight: 'Overnight name ideas',
  setup_help: 'Setup assistant',
  help_answer: 'Help assistant',
  alert_help: 'Ops copilot',
  portfolio_copilot: 'Portfolio copilot',
  order_screening: 'Name checks',
  site_assistant: 'Site assistant',
}

export function featureLabel(feature: string): string {
  return (FEATURE_LABEL as Readonly<Record<string, string>>)[feature] ?? feature.replace(/_/g, ' ')
}

export const COLUMNS = {
  feature: 'Feature',
  calls: 'Calls',
  failed: 'No answer',
  declined: 'Could not help',
  tokensIn: 'Tokens in (cached)',
  tokensOut: 'Tokens out',
  cost: 'Estimated cost',
} as const

export const IMPACT_HEADING = 'Is it working?'
export const IMPACT_INTRO =
  'Each phase is judged against a number the plan named. New domains, delegation, name checks and bulk changes count the side shown.'

export const PHASES = {
  one: 'Phase 1 — find and point',
  two: 'Phase 2 — answer and watch',
  three: 'Phase 3 — the portfolio copilot and AI buyers',
  five: 'Phase 5 — one assistant on every page',
} as const

export const NOT_MEASURED = {
  searchConversion:
    'Not measured: searches are not counted (FR-S7), so there is nothing to divide by. Target 6% of searches reaching checkout.',
  supportEmails:
    'Not measured: support email arrives in the hello@ mailbox, outside the product. Count it there, against paid orders on the overview.',
} as const

export const MEASURE = {
  finderLines: 'New domains from the name finder',
  pointed: 'Pointed and verified within 7 days',
  searchConversion: 'Search to checkout',
  finderCalls: 'Name finder requests',
  help: 'Help assistant',
  screening: 'Name checks',
  supportEmails: 'Support emails per 100 orders',
  bulk: 'Bulk changes by accounts with 10 or more domains',
  copilot: 'Portfolio copilot',
  assistantLines: 'New domains from AI assistants’ links',
  siteAssistantLines: 'New domains from the site assistant',
  siteAssistant: 'Site assistant messages',
} as const

/** "3 of 40 paid new domains (8%)". */
export function shareWords(part: number, whole: number, of: string): string {
  if (whole === 0) return `None — no ${of} in the last 30 days.`
  const share = Math.round((part / whole) * 100)
  return `${part.toLocaleString('en-GB')} of ${whole.toLocaleString('en-GB')} ${of} (${share}%)`
}

export function pointedWords(verified: number, registered: number): string {
  if (registered === 0)
    return 'No domains were registered at least 7 days ago in this window. Target 60%.'
  const share = Math.round((verified / registered) * 100)
  return `${share}% — ${verified} of ${registered} domains registered at least 7 days ago. Target 60%.`
}

export function helpWords(answered: number, declined: number, failed: number): string {
  const asked = answered + declined + failed
  if (asked === 0) return 'No questions asked.'
  return `${asked} asked: ${answered} answered from the help pages, ${declined} pointed to email, ${failed} with no answer.`
}

export function screeningWords(screened: number, flagged: number, waiting: number): string {
  if (screened === 0) return 'No new names screened.'
  const waits =
    waiting === 0 ? 'every flagged name has a decision' : `${waiting} waiting for a person`
  return `${screened} new names screened, ${flagged} flagged; ${waits}. Target: a person decides every flagged name.`
}

export function bulkWords(current: number, prior: number, agencies: number): string {
  if (agencies === 0) return 'No account holds 10 or more domains on this side.'
  return `${current} in the last 30 days, ${prior} in the 30 before, from ${agencies} ${agencies === 1 ? 'account' : 'accounts'} holding 10 or more domains. Target: more than before.`
}

export function copilotWords(answered: number, declined: number, failed: number): string {
  const asked = answered + declined + failed
  if (asked === 0) return 'Not used yet.'
  return `${answered} drafts made, ${declined} questions it asked back or changes it refused, ${failed} with no answer.`
}

export function assistantWords(answered: number, declined: number, failed: number): string {
  const asked = answered + declined + failed
  if (asked === 0) return 'Not used yet.'
  return `${asked} messages: ${answered} answered, ${declined} it could not help with, ${failed} with no answer.`
}

export function callsWords(calls: number, failed: number): string {
  if (calls === 0) return 'Not used yet.'
  return `${calls} requests, ${failed} without an answer.`
}
