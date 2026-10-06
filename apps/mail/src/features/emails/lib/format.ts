/**
 * Times as the dashboard shows them: Lagos time (WAT, UTC+1 all year — no
 * daylight saving), written out by hand rather than by `Intl`, whose words
 * differ between Node and each browser ("Sep" or "Sept", "," or "at") and
 * would make a page hydrate differently from how the server drew it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LAGOS_OFFSET_MS = 60 * 60 * 1000

const pad = (n: number) => String(n).padStart(2, '0')

function lagosParts(iso: string) {
  const at = new Date(new Date(iso).getTime() + LAGOS_OFFSET_MS)
  return {
    day: at.getUTCDate(),
    month: MONTHS[at.getUTCMonth()] ?? '',
    year: at.getUTCFullYear(),
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
    seconds: pad(at.getUTCSeconds()),
  }
}

/** "6 Oct 2026, 10:42" */
export function lagosTime(iso: string): string {
  const { day, month, year, time } = lagosParts(iso)
  return `${day} ${month} ${year}, ${time}`
}

/** "6 Oct 2026, 10:42:07" — for a timeline, where seconds tell events apart. */
export function lagosTimeWithSeconds(iso: string): string {
  const { day, month, year, time, seconds } = lagosParts(iso)
  return `${day} ${month} ${year}, ${time}:${seconds}`
}

/** A Lagos calendar day, `YYYY-MM-DD`, as the start of that day (an ISO moment). */
export const lagosDayStart = (day: string) => `${day}T00:00:00+01:00`

/** The moment after a Lagos day ends: the next day's start. */
export function lagosDayEnd(day: string): string {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return lagosDayStart(next.toISOString().slice(0, 10))
}
