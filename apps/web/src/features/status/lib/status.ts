import { z } from 'zod'

/**
 * The public status page, read from `public_status()` (migration 26): times
 * and one flag, no counts, names or amounts. This file decides what each
 * means, and the page says exactly that and nothing more (N9b).
 */
export type PublicStatus = {
  /** The database's clock when it answered — every age is measured from it. */
  checkedAt: string
  /** The live gateway's latest heartbeat. Null: none on record. */
  gatewaySeenAt: string | null
  /** The latest live reconciliation that finished without error. Null: none on record. */
  registryCheckedAt: string | null
  /** A live paid order has waited past the stuck-order threshold (ops_settings). */
  ordersDelayed: boolean
}

const schema = z.object({
  checked_at: z.string(),
  gateway_seen_at: z.string().nullable(),
  registry_checked_at: z.string().nullable(),
  orders_delayed: z.boolean(),
})

/** Null when the answer is not the shape the page was built for. */
export function parsePublicStatus(json: unknown): PublicStatus | null {
  const parsed = schema.safeParse(json)
  if (!parsed.success) return null
  const time = (value: string | null) => {
    if (value === null) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const checkedAt = time(parsed.data.checked_at)
  if (!checkedAt) return null
  return {
    checkedAt,
    gatewaySeenAt: time(parsed.data.gateway_seen_at),
    registryCheckedAt: time(parsed.data.registry_checked_at),
    ordersDelayed: parsed.data.orders_delayed,
  }
}

/**
 * The gateway records a heartbeat every 5 minutes (ALERT_EVERY_MINUTES), so
 * 15 minutes is three missed in a row — more than a blip.
 */
export const GATEWAY_FRESH_MINUTES = 15
/** Registry checks run hourly (RECONCILE_EVERY_MINUTES): two hours is a missed run. */
export const REGISTRY_FRESH_HOURS = 2

export type LineState = 'operational' | 'delayed'

export type StatusLine = {
  id: 'provisioning' | 'orders' | 'registry'
  title: string
  /** What the line is about, in plain words. */
  meaning: string
  state: LineState
  detail: string
}

export type StatusReport = {
  overall: LineState
  checkedAt: string
  lines: StatusLine[]
}

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})
const timeFormat = new Intl.DateTimeFormat('en-NG', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Africa/Lagos',
})

/** "14:05 on 24 September 2026", Lagos time. */
export function formatStatusTime(iso: string): string {
  const at = new Date(iso)
  return `${timeFormat.format(at)} on ${dateFormat.format(at)}`
}

/** Seen within `limitMs` of `checkedAt`. A time ahead of the clock counts as fresh. */
function isFresh(at: string | null, checkedAt: string, limitMs: number): boolean {
  if (!at) return false
  return new Date(checkedAt).getTime() - new Date(at).getTime() <= limitMs
}

export function evaluateStatus(status: PublicStatus): StatusReport {
  const { checkedAt } = status

  const gatewayUp = isFresh(status.gatewaySeenAt, checkedAt, GATEWAY_FRESH_MINUTES * 60_000)
  const provisioning: StatusLine = {
    id: 'provisioning',
    title: 'Registrations, renewals and nameserver changes',
    meaning: 'The service that carries out paid orders and nameserver changes at the registry.',
    state: gatewayUp ? 'operational' : 'delayed',
    detail: gatewayUp
      ? `Running. It last checked in at ${formatStatusTime(status.gatewaySeenAt as string)}.`
      : `Delayed — paid orders wait in a queue and are processed when it returns. ${
          status.gatewaySeenAt
            ? `It last checked in at ${formatStatusTime(status.gatewaySeenAt)}.`
            : 'We have no record of it checking in.'
        }`,
  }

  const orders: StatusLine = {
    id: 'orders',
    title: 'Paid orders',
    meaning: 'Whether any paid order is taking longer than usual to complete.',
    state: status.ordersDelayed ? 'delayed' : 'operational',
    detail: status.ordersDelayed
      ? 'Delayed — some are taking longer than usual. They stay in the queue until they are processed.'
      : 'None is waiting longer than usual.',
  }

  const registryUp = isFresh(
    status.registryCheckedAt,
    checkedAt,
    REGISTRY_FRESH_HOURS * 60 * 60_000,
  )
  const registry: StatusLine = {
    id: 'registry',
    title: 'Registry checks',
    meaning:
      'We regularly compare every domain we manage with the registry’s own record, so your account shows what the registry holds.',
    state: registryUp ? 'operational' : 'delayed',
    detail: registryUp
      ? `The last check finished at ${formatStatusTime(status.registryCheckedAt as string)}.`
      : `Delayed — ${
          status.registryCheckedAt
            ? `the last check finished at ${formatStatusTime(status.registryCheckedAt)}`
            : 'we have no record of a finished check'
        }. Your domains are not affected, but expiry dates and nameservers in your account may be out of date until the next one.`,
  }

  const lines = [provisioning, orders, registry]
  return {
    overall: lines.every((line) => line.state === 'operational') ? 'operational' : 'delayed',
    checkedAt,
    lines,
  }
}
