import { z } from 'zod'

/**
 * Portfolio labels (PRD FR-P3): the account's own, coloured, many per
 * domain, and a filter on the portfolio. The database keeps the rules
 * (migration 32): 1–30 characters, one of six named colours, 50 an account,
 * one of each name. These mirror them so a form can say so before it asks.
 */

/** Stored by name; each maps to a pair of design tokens (S2), never a hex. */
export const LABEL_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'slate'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

export const LABEL_COLOR_NAME: Record<LabelColor, string> = {
  blue: 'Blue',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  purple: 'Purple',
  slate: 'Slate',
}

export const LABEL_MAX_LENGTH = 30
export const LABEL_LIMIT = 50

export type DomainLabel = { id: string; name: string; color: LabelColor }

export const labelNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the label a name.')
  .max(LABEL_MAX_LENGTH, `Keep it to ${LABEL_MAX_LENGTH} characters.`)

export const labelColorSchema = z.enum(LABEL_COLORS)

/** An unknown colour from an old row shows as slate rather than breaking the page. */
export function asLabelColor(value: string): LabelColor {
  return (LABEL_COLORS as readonly string[]).includes(value) ? (value as LabelColor) : 'slate'
}

/** A label as read from `domain_labels`, with its colour made safe to render. */
export function toLabel(row: { id: string; name: string; color: string }): DomainLabel {
  return { id: row.id, name: row.name, color: asLabelColor(row.color) }
}

/** By name, whatever the case — how a person scans a list of them. */
export function sortLabels<T extends { name: string }>(labels: readonly T[]): T[] {
  return [...labels].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }),
  )
}

/**
 * What a refused write means, in words. The unique index is on the lower-
 * cased name (23505); the 50-label trigger raises a check violation (23514).
 */
export function labelWriteError(
  error: { code?: string | undefined } | null,
  name?: string,
): string {
  if (error?.code === '23505') {
    return name
      ? `You already have a label called “${name}”.`
      : 'You already have a label with that name.'
  }
  if (error?.code === '23514') return `An account can have up to ${LABEL_LIMIT} labels.`
  return 'That label could not be saved. Please try again.'
}

/** `?label=` — only one of the account's own labels filters anything. */
export function parseLabelFilter(
  value: string | undefined,
  labels: readonly { id: string }[],
): string | null {
  return value && labels.some((label) => label.id === value) ? value : null
}
