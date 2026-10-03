/**
 * CSV cells and files, built in the browser from what a page already shows
 * — the portfolio (FR-P4) and the admin Money page (ADMIN-SPEC §5.2 B7).
 *
 * RFC 4180 quoting, plus a guard against formula injection: a spreadsheet
 * runs a cell starting with = + - @ (or a tab or carriage return) as a
 * formula. A label is the customer's own text, and a list shared with a
 * client could otherwise carry `=HYPERLINK(...)` into their spreadsheet —
 * so such a cell is prefixed with an apostrophe, which spreadsheets show as
 * text (OWASP's advice). CLAUDE.md §15, "CSV export guards against formulas".
 */

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text
}

/** Rows to a file: CRLF between records, as RFC 4180 has it. */
export function toCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
