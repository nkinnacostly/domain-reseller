import type { NameIdeaLanguage } from '@dr/shared/ai'
import type { HelpAnswer } from '@/features/legal/lib/help-assistant'
import type { NameIdeaRow } from '@/features/search/lib/name-ideas'
import type { SearchRow } from '@/features/search/lib/rows'

/**
 * The site assistant (AI phase 5): one place on every page to find a name,
 * check one, see prices, point a domain or ask about MyDomainsHub. The model
 * only reads what a person wants; every answer comes from the engine that
 * already gives it — the name finder, the registry, the price tables, the
 * checked nameserver presets and the help centre (N5b, N8, N9b, N11).
 *
 * This file is what the browser may hold: limits, the reply shapes and the
 * short memo each reply leaves in the conversation. Types only from the AI
 * module, which never reaches a client component.
 */

export const MESSAGE_MIN = 2
export const MESSAGE_MAX = 500
/** How much of the conversation goes back with each message: enough for "shorter ones, please". */
export const HISTORY_MAX = 6
export const TURN_MAX = 600
/** Names checked from one message: one supplier call per extension, five at most. */
export const CHECK_MAX = 5
export const PRICES_MAX = 8

export type Turn = { role: 'person' | 'assistant'; text: string }

export type SetupPreset = {
  provider: string
  nameservers: string[]
  assignsPerZone: boolean
  sourceUrl: string
}

export type AssistantReply =
  /** Available names for a description, checked just now on one extension. */
  | {
      kind: 'names'
      ideas: NameIdeaRow[]
      checked: number
      tld: string
      language: NameIdeaLanguage
      /** The extension asked for, when we do not sell it and offered `tld` instead. */
      notSold: string | null
    }
  /** Named domains, checked with the registry and priced from the tables. */
  | { kind: 'check'; rows: SearchRow[]; notSold: string[] }
  /** Past the search allowance: the search page, where the human check lifts it (SEC-9). */
  | { kind: 'search'; query: string }
  | { kind: 'prices'; prices: { tld: string; words: string }[]; notSold: string[]; vatPct: number }
  /** How to point a domain at a host: a checked preset when we hold one (N11). */
  | { kind: 'setup'; host: string | null; preset: SetupPreset | null }
  | { kind: 'help'; help: HelpAnswer }
  | { kind: 'other' }

export type AssistantFailure = 'off' | 'limited' | 'busy' | 'unavailable'

export type AskAssistantResult =
  | { ok: true; reply: AssistantReply; memo: string }
  | { ok: false; reason: AssistantFailure }

/** Starting points for an empty conversation — each one a different engine. */
export const ASSISTANT_STARTERS = [
  'Find a name for my bakery in Ibadan',
  'Is lagosbakes.com free?',
  'How much is a .com domain?',
  'How do I point my domain at Vercel?',
] as const

const listed = (items: readonly string[], max = 8) =>
  items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ')

/**
 * What a reply leaves in the conversation for the next message to build on —
 * names and outcomes, never a price (prices are read from the tables each
 * time) and never anything about the person.
 */
export function memoOf(reply: AssistantReply): string {
  switch (reply.kind) {
    case 'names':
      return reply.ideas.length > 0
        ? `Suggested available .${reply.tld} names: ${listed(reply.ideas.map((idea) => idea.row.display))}.`
        : `None of the ${reply.checked} .${reply.tld} names tried were free.`
    case 'check':
      return reply.rows.length > 0
        ? `Checked: ${listed(reply.rows.map((row) => `${row.display} ${row.status === 'available' ? 'is free' : 'is not free'}`))}.`
        : `Those extensions are not sold here: ${listed(reply.notSold)}.`
    case 'search':
      return `Sent them to the search page for ${reply.query}.`
    case 'prices':
      return `Showed prices for ${listed(reply.prices.map((price) => `.${price.tld}`))}.`
    case 'setup':
      return `Explained pointing a domain at ${reply.preset?.provider ?? reply.host ?? 'a host'}.`
    case 'help':
      return reply.help.answered
        ? reply.help.answer.slice(0, TURN_MAX)
        : 'The help centre did not cover that question.'
    case 'other':
      return 'Said what the assistant can help with.'
  }
}

/** The conversation as it goes back to the server: the latest turns, each cut to size. */
export function historyOf(turns: readonly Turn[]): Turn[] {
  return turns
    .slice(-HISTORY_MAX)
    .map((turn) => ({ role: turn.role, text: turn.text.slice(0, TURN_MAX) }))
}
