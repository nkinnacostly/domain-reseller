/**
 * Words for when a session was used (PRD FR-A5). Pure: the caller passes the
 * clock, so the page and its tests agree.
 *
 * "Last seen" is when the device last renewed its sign-in, which an active
 * device does about once an hour (the access token lasts an hour). So it is
 * never more precise than that: "in the last hour", not "2 minutes ago".
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const dayFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})

export function formatSessionDate(iso: string): string {
  return dayFormat.format(new Date(iso))
}

export function describeLastSeen(iso: string, now: Date): string {
  const elapsed = now.getTime() - new Date(iso).getTime()
  if (elapsed < HOUR) return 'in the last hour'
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(elapsed / DAY)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return `on ${formatSessionDate(iso)}`
}
