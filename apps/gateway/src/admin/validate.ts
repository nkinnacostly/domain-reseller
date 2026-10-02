import { domainToASCII } from 'node:url'
import { ADMIN_PRICE_OPS, type AdminPriceOp, type AdminSide } from '@dr/shared/admin'
import { nameserverSchema } from '@dr/shared/schemas'
import { z } from 'zod'

/**
 * Admin route inputs, checked before the note is claimed (docs/ADMIN-SPEC.md
 * §4.2): a bad input is a 400 and the note stays an unclaimed intent. Each
 * returns the normalised value, or null when the input is wrong.
 */

const ASCII_ONLY = /^\p{ASCII}*$/u

/** A host name in ASCII, lower-cased: punycode for a name typed in another script. */
export function asciiHost(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '' || /[/@:?#\\\s]/.test(trimmed)) return null
  if (ASCII_ONLY.test(trimmed)) return trimmed.toLowerCase()
  const ascii = domainToASCII(trimmed)
  return ascii === '' ? null : ascii.toLowerCase()
}

/** A domain name (`:name`). A `*.` prefix only where a wildcard certificate is asked about. */
export function validName(input: string | undefined, allowWildcard = false): string | null {
  if (!input) return null
  let rest = input.trim()
  let prefix = ''
  if (rest.startsWith('*.')) {
    if (!allowWildcard) return null
    prefix = '*.'
    rest = rest.slice(2)
  }
  const host = asciiHost(rest)
  if (!host) return null
  const parsed = nameserverSchema.safeParse(host)
  return parsed.success ? `${prefix}${parsed.data}` : null
}

const EXTENSION = /^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/

export function validTld(input: string | undefined): string | null {
  const value = (input ?? '').trim().toLowerCase().replace(/^\./, '')
  return EXTENSION.test(value) ? value : null
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A supplier trace id: any 8-4-4-4-12 hex GUID, lower-cased (not RFC 9562). */
export function validTrace(input: string | undefined): string | null {
  return input && GUID.test(input.trim()) ? input.trim().toLowerCase() : null
}

function integer(input: string | undefined, min: number, max: number): number | null {
  if (input === undefined || !/^\d{1,10}$/.test(input)) return null
  const value = Number(input)
  return value >= min && value <= max ? value : null
}

export const validSkip = (input: string | undefined) => integer(input ?? '0', 0, 10_000)
export const validTake = (input: string | undefined) => integer(input ?? '25', 1, 100)
export const validSmallInt = (input: string) => integer(input, 0, 20)
export const validYears = (input: string | undefined) => integer(input ?? '1', 1, 10)

export function validOp(input: string | undefined): AdminPriceOp | null {
  const value = input ?? 'register'
  return (ADMIN_PRICE_OPS as readonly string[]).includes(value) ? (value as AdminPriceOp) : null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** `YYYY-MM-DD` dates at most 366 days apart, from no later than to. */
export function validRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { from: string; to: string } | null {
  const today = now.toISOString().slice(0, 10)
  const end = to ?? today
  const start =
    from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 6 * DAY_MS).toISOString().slice(0, 10)
  if (!DATE.test(start) || !DATE.test(end)) return null
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a || b - a > 366 * DAY_MS) return null
  // A date that rolled over (2026-02-31) is not a date.
  if (
    new Date(a).toISOString().slice(0, 10) !== start ||
    new Date(b).toISOString().slice(0, 10) !== end
  ) {
    return null
  }
  return { from: start, to: end }
}

/** An exact hostname to search the live ledger for. */
export const validQuery = (input: string | undefined) => (input ? validName(input) : null)

export const validFlwRefundId = (input: string | undefined) =>
  input && /^[A-Za-z0-9_-]{1,64}$/.test(input) ? input : null

const uuid = z.uuid()

/** A refund (uuid), an incident (bigint) or a draft (uuid) id. */
export function validId(input: string | undefined, kind: 'uuid' | 'bigint'): string | null {
  if (!input) return null
  if (kind === 'bigint') return /^\d{1,19}$/.test(input) ? input : null
  return uuid.safeParse(input).success ? input.toLowerCase() : null
}

export function validSide(input: string | undefined): AdminSide | null {
  return input === 'live' || input === 'test' ? input : null
}
