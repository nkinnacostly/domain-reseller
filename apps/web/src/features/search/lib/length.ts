import { isIdn, toUnicodeHost } from './idn'

/**
 * Per-extension length rules (PRD FR-S9): the shortest and longest name a
 * registry accepts, from the supplier's catalogue (`tlds.min_chars`,
 * `tlds.max_chars`). A name outside them is answered here, without spending
 * one of the supplier's two slots on a certain refusal. Null means the rule
 * is not known yet — then the supplier decides, as before.
 */
export type LengthRule = { min: number | null; max: number | null }
export type LengthRules = Readonly<Record<string, LengthRule>>

export type LengthIssue = LengthRule & { kind: 'too-short' | 'too-long' }

/**
 * Counted on the ASCII form, because that is what the supplier receives and
 * measures: an international name's `xn--` form is longer than it looks.
 */
export function lengthIssue(stem: string, rule: LengthRule | undefined): LengthIssue | null {
  if (!rule) return null
  if (rule.min !== null && stem.length < rule.min) return { kind: 'too-short', ...rule }
  if (rule.max !== null && stem.length > rule.max) return { kind: 'too-long', ...rule }
  return null
}

/** "Too short for .io (3–63 characters)". */
export function describeLengthIssue(issue: LengthIssue, stem: string, tld: string): string {
  const range =
    issue.min !== null && issue.max !== null
      ? `${issue.min}–${issue.max} characters`
      : issue.min !== null
        ? `at least ${issue.min} characters`
        : `at most ${issue.max} characters`
  const counted = isIdn(stem) ? ', counted in its xn-- form' : ''
  return `Too ${issue.kind === 'too-short' ? 'short' : 'long'} for .${toUnicodeHost(tld)} (${range}${counted})`
}
