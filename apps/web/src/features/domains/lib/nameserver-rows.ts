import { NAMESERVERS_MIN } from '@dr/shared/schemas'

/**
 * FR-D1 — the nameserver editor's rows, one nameserver each. Pure, so the
 * form's rules are tested without rendering it. Each row keeps a stable key
 * for React and for moving focus when rows come and go.
 */
export type NameserverRow = { key: number; value: string }

/** Rows for a set of nameservers, padded with empty ones to the minimum. */
export function toRows(values: readonly string[], nextKey: () => number): NameserverRow[] {
  const rows = values.map((value) => ({ key: nextKey(), value }))
  while (rows.length < NAMESERVERS_MIN) rows.push({ key: nextKey(), value: '' })
  return rows
}

/**
 * The hostnames in text pasted from a host's email — one per line, or
 * separated by commas or spaces, often with words around them ("Nameserver 1:
 * ns1.host.com"). A hostname has a dot; the words do not. Null when the text
 * is a single entry, which the input takes as it is.
 */
export function pastedNameservers(text: string): string[] | null {
  const tokens = text.split(/[\s,;]+/).filter(Boolean)
  if (tokens.length < 2) return null
  const hosts = tokens.filter((token) => token.includes('.'))
  return hosts.length > 0 ? hosts : null
}

/**
 * A list pasted into one row: the row takes the first, new rows after it take
 * the rest, and empty rows below make way for them. A single-line input would
 * otherwise run the lines together into one hostname.
 */
export function pasteInto(
  rows: readonly NameserverRow[],
  index: number,
  hosts: readonly string[],
  nextKey: () => number,
): NameserverRow[] {
  const target = rows[index]
  if (!target || hosts.length === 0) return [...rows]
  const pasted = hosts.map((value, n) =>
    n === 0 ? { ...target, value } : { key: nextKey(), value },
  )
  const after = rows.slice(index + 1).filter((row) => row.value.trim())
  return [...rows.slice(0, index), ...pasted, ...after]
}

/** What the action receives: the filled rows, one per line — the string the old box sent. */
export function joinRows(rows: readonly NameserverRow[]): string {
  return rows
    .map((row) => row.value.trim())
    .filter(Boolean)
    .join('\n')
}
