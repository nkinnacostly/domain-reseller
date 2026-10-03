import { formatUsdCents } from '@dr/shared/admin'

/**
 * How the admin dashboard writes times, money and identifiers (ADMIN-SPEC
 * §5.1). Times are Lagos time (WAT, UTC+1, no daylight saving); money is
 * integer kobo or cents, formatted only here, at the display edge (N5).
 */

const WAT_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Lagos',
})
const WAT_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Lagos',
})
const WAT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})

const valid = (value: string | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "2 Oct 2026, 14:05 WAT" — or a dash for nothing. */
export function formatWat(value: string | Date | null | undefined): string {
  const date = valid(value)
  return date ? `${WAT_DATE_TIME.format(date)} WAT` : '—'
}

/** "14:05 WAT". */
export function formatWatTime(value: string | Date | null | undefined): string {
  const date = valid(value)
  return date ? `${WAT_TIME.format(date)} WAT` : '—'
}

/** "2 Oct 2026". */
export function formatWatDate(value: string | Date | null | undefined): string {
  const date = valid(value)
  return date ? WAT_DATE.format(date) : '—'
}

/** "just now", "5 min ago", "3 h ago", "4 days ago" — or "in 2 days" for the future. */
export function ago(value: string | Date | null | undefined, now: Date): string {
  const date = valid(value)
  if (!date) return '—'
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
  const future = seconds < 0
  const s = Math.abs(seconds)
  let text: string
  if (s < 60) return future ? 'in under a minute' : 'just now'
  if (s < 3600) text = `${Math.floor(s / 60)} min`
  else if (s < 86_400) text = `${Math.floor(s / 3600)} h`
  else {
    const days = Math.floor(s / 86_400)
    text = `${days} ${days === 1 ? 'day' : 'days'}`
  }
  return future ? `in ${text}` : `${text} ago`
}

/** "$43.38" from integer cents (D24). Never a float USD. */
export function formatUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return formatUsdCents(cents)
}

/**
 * `a•••@gmail.com` — the same mask as SQL `admin_mask_email()`, so a masked
 * address reads the same from a view, a function or the browser.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—'
  if (!email.includes('@')) return '•••'
  // split_part(p_email, '@', n): the local part before the first @, the
  // domain between the first and the second. One character of the local
  // part, not one UTF-16 unit — as SQL's left(local, 1).
  const [local = '', domain = ''] = email.split('@')
  return `${Array.from(local)[0] ?? ''}•••@${domain}`
}

/** The last three digits only: "•••• 123". */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  return digits.length <= 3 ? '••••' : `•••• ${digits.slice(-3)}`
}

/** The first eight characters of an id: enough to tell rows apart on screen. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.replace(/-/g, '').slice(0, 8)
}

/** A whole count with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return Math.round(value).toLocaleString('en-GB')
}
