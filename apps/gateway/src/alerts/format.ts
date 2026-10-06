import { adminHrefForAlertKey } from '@dr/shared/admin'
import { env } from '../env'
import type { DueAlert } from './store'
import { TELEGRAM_MAX_CHARS } from './telegram'

/**
 * Turns due alerts into as few messages as fit, newest problems first:
 * what is new, what is still open, what has cleared. Each message carries the
 * ids it covers, so only delivered alerts are marked sent.
 */

export type AlertMessage = { text: string; alertIds: number[]; resolvedIds: number[] }

/** Leaves room for the header under Telegram's limit. */
const BUDGET = TELEGRAM_MAX_CHARS - 200

const lagosTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * Where to work an alert in the admin dashboard (ADMIN-SPEC §4.5), when the
 * site is known. A Mail alert's link is already absolute: Mail's own admin
 * (MAIL-SPEC §11).
 */
function link(alert: DueAlert, appUrl: string | undefined): string {
  if (!alert.key) return ''
  const href = adminHrefForAlertKey(alert.key)
  if (href.startsWith('https://')) return ` — ${href}`
  if (!appUrl) return ''
  return ` — ${appUrl.replace(/\/+$/, '')}${href}`
}

function line(alert: DueAlert, appUrl: string | undefined): string {
  if (alert.type === 'resolved') return `✅ ${alert.summary}`
  const mark = alert.severity === 'critical' ? '🔴' : '🟠'
  const since =
    alert.type === 'reminder'
      ? ` (open since ${lagosTime.format(new Date(alert.firstSeenAt))})`
      : ''
  return `${mark} ${alert.summary}${since}${link(alert, appUrl)}`
}

const SECTIONS: { type: DueAlert['type']; title: string }[] = [
  { type: 'new', title: 'New' },
  { type: 'reminder', title: 'Still open' },
  { type: 'resolved', title: 'Cleared' },
]

export function formatAlerts(
  alerts: DueAlert[],
  side: 'live' | 'test',
  appName: string,
  appUrl: string | undefined = env.APP_URL,
): AlertMessage[] {
  const ordered = SECTIONS.flatMap(({ type, title }) =>
    alerts
      .filter((alert) => alert.type === type)
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
      .map((alert) => ({ alert, title })),
  )
  if (ordered.length === 0) return []

  const critical = alerts.some(
    (alert) => alert.type !== 'resolved' && alert.severity === 'critical',
  )
  const header = `${critical ? '🚨' : 'ℹ️'} ${appName} (${side})`

  const messages: AlertMessage[] = []
  let body: string[] = []
  let size = 0
  let alertIds: number[] = []
  let resolvedIds: number[] = []
  let section = ''

  const flush = () => {
    if (body.length === 0) return
    messages.push({ text: [header, ...body].join('\n'), alertIds, resolvedIds })
    body = []
    size = 0
    alertIds = []
    resolvedIds = []
    section = ''
  }

  for (const { alert, title } of ordered) {
    const text = line(alert, appUrl).slice(0, BUDGET - 50)
    const heading = `\n${title}:`
    const added = text.length + 1 + (title === section ? 0 : heading.length + 1)
    if (size + added > BUDGET) flush()
    if (title !== section) {
      body.push(heading)
      size += heading.length + 1
      section = title
    }
    body.push(text)
    size += text.length + 1
    if (alert.type === 'resolved') resolvedIds.push(alert.id)
    else alertIds.push(alert.id)
  }
  flush()
  return messages
}
