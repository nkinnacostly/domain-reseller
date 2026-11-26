import type { NameIdeaLanguage } from '@dr/shared/ai'
import type { SearchRow } from './rows'

/**
 * The AI name finder (docs: "Making AI the core of MyDomainsHub", feature 1):
 * a sentence about a business in, available names out, each priced from the
 * catalogue with its renewal price (N8). The model only proposes labels.
 */

/** What a person can type: a sentence or two, never an essay to pay for. */
export const DESCRIPTION_MIN = 10
export const DESCRIPTION_MAX = 400

/** The extensions offered, in order, where the catalogue prices them. */
export const NAME_FINDER_EXTENSIONS = ['com', 'ng', 'com.ng', 'co', 'io', 'org'] as const

/**
 * The languages the finder answers in (AI phase 4), for the picker: the
 * codes `@dr/shared/ai` takes (a test holds them together), written here
 * because a client component may not import the AI module.
 */
export const NAME_FINDER_LANGUAGES: readonly { code: NameIdeaLanguage; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'pcm', label: 'Pidgin' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ig', label: 'Igbo' },
  { code: 'ha', label: 'Hausa' },
]

export type NameIdeaRow = { row: SearchRow; why: string | null }

export type NameIdeasResult =
  | {
      ok: true
      /** Available names only, in the model's order. */
      ideas: NameIdeaRow[]
      /** How many names were checked, so "none free" can say of how many. */
      checked: number
    }
  /**
   * `off` — no AI key set; `limited` — past this address's allowance;
   * `busy` — the supplier asked us to slow down; `unavailable` — the model,
   * the gateway or the prices could not answer.
   */
  | { ok: false; reason: 'off' | 'limited' | 'busy' | 'unavailable' }

/** Available rows, in the order the ideas came, each with the model's reason. */
export function availableIdeas(
  rows: readonly SearchRow[],
  why: ReadonlyMap<string, string | null>,
): NameIdeaRow[] {
  return rows
    .filter((row) => row.status === 'available' && row.price)
    .map((row) => ({ row, why: why.get(row.name) ?? null }))
}
