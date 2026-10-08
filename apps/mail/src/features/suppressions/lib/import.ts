import { parseMailbox } from '@dr/shared/mail'

/**
 * Reading a suppression list someone brings from another provider (migration
 * 68), in the browser: the file never leaves it, only the addresses do. The
 * exports differ — Resend, SendGrid and Postmark head the column `email`,
 * Mailgun `address`, Brevo `EMAIL`, Mailchimp `Email Address` — so a column
 * whose heading names an address is used; without one, each row's first cell
 * that is an address. A plain list, one address a line, is a one-column file
 * without a heading. Pure: no React, no I/O.
 */

/** What one import may hold: the dashboard says so before reading further. */
export const IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxAddresses: 100_000,
  /** One server action call: under import_suppressions' 5,000 and Next's 1 MB body. */
  chunkAddresses: 5_000,
  chunkChars: 400_000,
} as const

export type ReadList = {
  /** Lower-case, each once, in the file's order. */
  addresses: string[]
  /** Rows with something in them but no address we could read (the heading not counted). */
  skipped: number
  /** Whether the file held more addresses than one import takes; the rest were left out. */
  truncated: boolean
}

const HEADINGS = new Set(['email', 'emailaddress', 'address', 'recipient', 'mail', 'emailid'])

const headingKey = (cell: string) => cell.toLowerCase().replace(/[^a-z]/g, '')

/** The delimiter the first line uses most: comma, semicolon or tab. */
function delimiterOf(firstLine: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const)
  const [best] = counts.sort((a, b) => b[1] - a[1])
  return best && best[1] > 0 ? best[0] : ','
}

/** RFC 4180 rows: quoted cells may hold the delimiter, quotes ("") and line breaks. */
export function csvRows(text: string): string[][] {
  const body = text.replace(/^﻿/, '')
  const newline = body.search(/\r?\n/)
  const delimiter = delimiterOf(newline === -1 ? body : body.slice(0, newline))
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** One cell as an address the list stores, or null. `Name <address>` is taken too. */
export function addressIn(cell: string): string | null {
  const text = cell.trim()
  if (!text.includes('@')) return null
  return parseMailbox(text)?.address.toLowerCase() ?? null
}

export function readSuppressionList(text: string): ReadList {
  const rows = csvRows(text).filter((row) => row.some((cell) => cell.trim() !== ''))
  const first = rows[0] ?? []
  const column = first.findIndex((cell) => HEADINGS.has(headingKey(cell)))
  const hasHeading =
    column !== -1 || (first.length > 1 && first.every((cell) => !cell.includes('@')))
  const seen = new Set<string>()
  const addresses: string[] = []
  let skipped = 0
  let truncated = false
  for (const row of hasHeading ? rows.slice(1) : rows) {
    const address =
      column !== -1
        ? addressIn(row[column] ?? '')
        : row.reduce<string | null>((found, cell) => found ?? addressIn(cell), null)
    if (!address) {
      skipped += 1
      continue
    }
    if (seen.has(address)) continue
    if (addresses.length === IMPORT_LIMITS.maxAddresses) {
      truncated = true
      break
    }
    seen.add(address)
    addresses.push(address)
  }
  return { addresses, skipped, truncated }
}

/** The addresses in calls of at most `chunkAddresses`, and `chunkChars` characters. */
export function importChunks(addresses: readonly string[]): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  let chars = 0
  for (const address of addresses) {
    if (
      chunk.length === IMPORT_LIMITS.chunkAddresses ||
      chars + address.length > IMPORT_LIMITS.chunkChars
    ) {
      chunks.push(chunk)
      chunk = []
      chars = 0
    }
    chunk.push(address)
    chars += address.length + 3
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}
