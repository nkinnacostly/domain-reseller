import type { ResultRow } from './bulk-run'
import { toUnicodeHost } from './idn'

/**
 * CSV in and out of bulk search (FR-S5). Read and written in the browser: an
 * uploaded file never leaves the device — only the names in it are sent, to
 * be checked — and an export is built from what the page already shows.
 *
 * Small on purpose: RFC 4180 fields (quotes, doubled quotes, line breaks in
 * quotes), the delimiters spreadsheets actually save with, and a UTF-8 byte
 * order mark. Not a general CSV library.
 */

/** Headers a names column is recognised by, whatever the case. */
const NAME_HEADERS = new Set(['domain', 'domains', 'domain name', 'domain names', 'name', 'names'])

export type CsvNames = {
  names: string[]
  /** The header the names came from, or null when the first column was used. */
  column: string | null
  /** Rows with nothing in the names column. */
  blank: number
  /** Names already read, in any case. */
  duplicates: number
  /** Cells with a space, comma or semicolon inside — no domain name has one. */
  unusable: number
}

/** Splits CSV text into rows of fields. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  // A file that ends with a line break has no row after it.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Commas, unless the first line is clearly split by semicolons or tabs (European Excel). */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n|\r/, 1)[0] ?? ''
  const counts = [',', ';', '\t'].map((candidate) => ({
    candidate,
    count: firstLine.split(candidate).length - 1,
  }))
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a))
  return best.count > 0 ? best.candidate : ','
}

/**
 * The names in a CSV file: the `domain` or `name` column when the first row
 * has one, the first column otherwise. Blank cells and repeats are skipped,
 * and counted, so the page can say why.
 */
export function readNamesFromCsv(text: string): CsvNames {
  const rows = parseCsv(text)
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? []
  const headerIndex = header.findIndex((cell) => NAME_HEADERS.has(cell))
  const column = headerIndex === -1 ? 0 : headerIndex
  const body = headerIndex === -1 ? rows : rows.slice(1)

  const seen = new Set<string>()
  const result: CsvNames = {
    names: [],
    column: headerIndex === -1 ? null : (rows[0]?.[headerIndex]?.trim() ?? null),
    blank: 0,
    duplicates: 0,
    unusable: 0,
  }
  for (const row of body) {
    const cell = (row[column] ?? '').trim()
    if (cell === '') {
      result.blank += 1
    } else if (/[\s,;]/.test(cell)) {
      result.unusable += 1
    } else if (seen.has(cell.toLowerCase())) {
      result.duplicates += 1
    } else {
      seen.add(cell.toLowerCase())
      result.names.push(cell)
    }
  }
  return result
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-NG')} ${count === 1 ? one : many}`

/**
 * What the page says after reading a file: how many names, from which
 * column, and why any rows were left out — so nothing goes missing silently.
 */
export function describeCsvRead(file: string, read: CsvNames): string {
  const from = read.column ? `the “${read.column}” column` : 'the first column'
  const parts = [`Read ${plural(read.names.length, 'name', 'names')} from ${from} of ${file}.`]
  const skipped = [
    read.blank > 0 ? plural(read.blank, 'blank row', 'blank rows') : null,
    read.duplicates > 0 ? plural(read.duplicates, 'repeat', 'repeats') : null,
    read.unusable > 0
      ? `${plural(read.unusable, 'entry', 'entries')} with a space or comma in ${read.unusable === 1 ? 'it' : 'them'}, which no domain name has`
      : null,
  ].filter((part): part is string => part !== null)
  if (skipped.length > 0) parts.push(`Left out ${joinWords(skipped)}.`)
  return parts.join(' ')
}

/** "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * One CSV cell. Spreadsheets run a cell that starts with = + - @ as a
 * formula, and a line typed into bulk search can start with anything, so such
 * a cell is kept as text with a leading apostrophe.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** Kobo as a plain naira figure for a spreadsheet, in whole-number arithmetic (N5). */
export function nairaFigure(kobo: number): string {
  const naira = Math.trunc(kobo / 100)
  return `${naira}.${String(kobo % 100).padStart(2, '0')}`
}

const STATUS_WORDS: Record<ResultRow['category'], string> = {
  available: 'available',
  taken: 'taken',
  premium: 'premium',
  refused: 'not available',
  unchecked: 'not checked',
  pending: 'not checked',
}

export const CSV_HEADER = [
  'name',
  'extension',
  'status',
  'first_term_price_ngn',
  'first_term_years',
  'renewal_price_ngn',
  'renewal_term_years',
  'ascii_name',
] as const

/**
 * The results as a spreadsheet: every row with its status, and for every
 * available name both its first price and its renewal price (N8), each with
 * the years it buys — one for most extensions, two for .ai, whose registry
 * sells no single year. A line that is not a domain keeps the reason it was
 * refused as its status.
 */
export function resultsCsv(rows: readonly ResultRow[]): string {
  const lines = rows.map((row) => [
    row.display,
    row.tld ? toUnicodeHost(row.tld) : '',
    row.label ? row.label.toLowerCase() : STATUS_WORDS[row.category],
    row.price ? nairaFigure(row.price.registerKobo) : '',
    row.price ? String(row.price.registerYears) : '',
    row.price ? nairaFigure(row.price.renewKobo) : '',
    row.price ? String(row.price.renewYears) : '',
    row.domain ?? '',
  ])
  // The byte order mark tells Excel the file is UTF-8, so café.com survives.
  return `\uFEFF${[[...CSV_HEADER], ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`
}
