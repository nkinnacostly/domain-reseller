/**
 * The name checks page's words (migration 73). What the screening is, and is
 * not: it reads the name only, and it never holds or refuses an order.
 */

export const SCREENING_TITLE = 'Name checks'
export const SCREENING_DESCRIPTION =
  'New paid domains whose names contain a well-known brand, bank or government service. Most are cleared by the word list or the model; the rest wait here for a person. Orders are never held for a check.'

export const OPEN_HEADING = 'Waiting for a review'
export const OPEN_EMPTY = 'Nothing is waiting. Names the screening passes to a person appear here.'
export const REVIEWED_HEADING = 'Reviewed recently'
export const REVIEWED_EMPTY = 'No names reviewed in the last 30 days.'

export const DECISION_LABEL: Readonly<Record<'fine' | 'abuse', string>> = {
  fine: 'Looks fine',
  abuse: 'Abuse',
}

export const REVIEW = {
  fine: {
    trigger: 'Looks fine',
    title: 'Mark this name as fine',
    body: 'The warning closes and your reason is kept with the check. Nothing about the order changes.',
    confirm: 'Mark as fine',
  },
  abuse: {
    trigger: 'Abuse',
    title: 'Mark this name as abuse',
    body: 'The warning closes and your reason is kept with the check. This records the finding only: report the domain or suspend it separately.',
    confirm: 'Mark as abuse',
  },
  reasonLabel: 'What you checked, and what you found',
  done: 'Review recorded.',
  rows: { name: 'Name', matched: 'Matched', note: 'Screening note' },
} as const

/** "30 names screened in the last 30 days; 28 cleared." */
export function screenedSummary(screened: number, cleared: number): string {
  if (screened === 0) return 'No names screened in the last 30 days.'
  const names = screened === 1 ? '1 name' : `${screened} names`
  return `${names} screened in the last 30 days; ${cleared} cleared without a person.`
}
