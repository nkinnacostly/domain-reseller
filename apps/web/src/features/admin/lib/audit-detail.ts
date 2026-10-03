import { formatNaira } from '@dr/shared'
import { HIDDEN_VALUE } from '@/features/admin/lib/audit-copy'
import { formatUsd, formatWat, maskEmail } from '@/features/admin/lib/format'

/**
 * An audit entry's `detail`, as lines a person can read (docs/ADMIN-SPEC.md
 * §2.5, §5.2 B14). The wrappers record ids, statuses, kinds, amounts and
 * limits — never contact details (migration 40) — and the gateway records
 * ids, counts and cents. This is the second line of defence all the same
 * (N13): a key that names personal data or a secret is never shown, an email
 * anywhere in a value is masked as `admin_mask_email` masks it, and a long or
 * deep value is cut short. It runs on the server, so a hidden value never
 * reaches the page.
 */

export type DetailLine = { label: string; value: string; hidden: boolean }

/** Keys, lower-cased with separators removed, whose values are never shown. */
const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  // Who someone is, and how to reach them.
  'email',
  'emails',
  'toemail',
  'approveremail',
  'recipient',
  'phone',
  'mobile',
  'name',
  'fullname',
  'firstname',
  'lastname',
  'businessname',
  'companyname',
  'organisation',
  'organization',
  'taxid',
  'address',
  'address1',
  'address2',
  'street',
  'city',
  'postcode',
  'postalcode',
  'zip',
  'contact',
  'contacts',
  'registrant',
  'pendingregistrant',
  'pendingcontacts',
  'deliverydetail',
  'ip',
  'ipaddress',
  'useragent',
  // Secrets and raw provider answers.
  'raw',
  'data',
  'body',
  'authcode',
  'privatekey',
  'secret',
  'key',
  'token',
  'password',
  'otp',
  'totp',
  'csr',
  'sessionid',
  'cardtoken',
])

const MAX_LINES = 40
const MAX_DEPTH = 4
const MAX_TEXT = 200

const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/

const normalise = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Whether a detail key names personal data or a secret. */
export function isPrivateKey(key: string): boolean {
  return PRIVATE_KEYS.has(normalise(key))
}

/** Every email address in a text, masked: `a•••@example.com`. */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL, (address) => maskEmail(address))
}

function cut(text: string): string {
  const masked = maskEmailsIn(text)
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT - 1)}…` : masked
}

/** Kobo and cents read as money; a time as Lagos time; the rest as written. */
function scalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') {
    const name = normalise(key)
    if (Number.isSafeInteger(value) && name.endsWith('kobo')) return formatNaira(value)
    if (Number.isSafeInteger(value) && name.endsWith('cents')) return formatUsd(value)
    return String(value)
  }
  if (typeof value === 'string') return TIMESTAMP.test(value) ? formatWat(value) : cut(value)
  return cut(String(value))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The detail as `path: value` lines, in the order it was recorded. Nothing
 * recorded (`{}`, or not an object) is no lines.
 */
export function detailLines(detail: unknown): DetailLine[] {
  const lines: DetailLine[] = []
  const seen = new Set<string>()
  let dropped = 0
  // Each line's label is its own: a path cut short could repeat another.
  const push = (line: DetailLine) => {
    if (lines.length >= MAX_LINES) {
      dropped += 1
      return
    }
    let label = line.label
    for (let copy = 2; seen.has(label); copy += 1) label = `${line.label} (${copy})`
    seen.add(label)
    lines.push({ ...line, label })
  }

  const walk = (path: string, key: string, value: unknown, depth: number) => {
    const label = cut(path)
    if (isPrivateKey(key)) {
      push({ label, value: HIDDEN_VALUE, hidden: true })
      return
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        push({ label, value: 'none', hidden: false })
      } else if (value.every((item) => !isRecord(item) && !Array.isArray(item))) {
        push({
          label,
          value: cut(value.map((item) => scalar(key, item)).join(', ')),
          hidden: false,
        })
      } else if (depth >= MAX_DEPTH) {
        push({ label, value: '[…]', hidden: false })
      } else {
        value.forEach((item, index) => {
          walk(`${path}[${index}]`, key, item, depth + 1)
        })
      }
      return
    }
    if (isRecord(value)) {
      const entries = Object.entries(value)
      if (entries.length === 0) {
        push({ label, value: 'none', hidden: false })
      } else if (depth >= MAX_DEPTH) {
        push({ label, value: '{…}', hidden: false })
      } else {
        for (const [child, inner] of entries) walk(`${path}.${child}`, child, inner, depth + 1)
      }
      return
    }
    push({ label, value: scalar(key, value), hidden: false })
  }

  if (!isRecord(detail)) return lines
  for (const [key, value] of Object.entries(detail)) walk(key, key, value, 1)
  if (dropped > 0) {
    lines.push({ label: '…', value: `${dropped} more not shown`, hidden: false })
  }
  return lines
}
