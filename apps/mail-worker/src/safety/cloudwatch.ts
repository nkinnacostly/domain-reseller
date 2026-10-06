import { signRequest } from '@dr/shared/ses'

/**
 * The SES account's reputation from CloudWatch (MAIL-SPEC §7.8):
 * `Reputation.BounceRate` and `Reputation.ComplaintRate` in `AWS/SES`, for
 * the whole account — the shop's own email included. Read with the sender
 * key, whose policy allows `cloudwatch:GetMetricData` and nothing else of
 * CloudWatch, over the JSON 1.0 protocol, signed with our own SigV4 (no AWS
 * SDK). SES publishes the rates as fractions; we keep parts per million.
 *
 * An answer is `ok` with the latest value of each (null when CloudWatch has
 * none in the window), `no_data` when it has neither, or `failed` with its
 * status and error type only.
 */

export type Reading =
  | {
      outcome: 'ok'
      bouncePpm: number | null
      complaintPpm: number | null
      metricAt: string | null
    }
  | { outcome: 'no_data' }
  | { outcome: 'failed'; status: number | null; code: string | null }

export type CloudWatchSettings = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  fetch?: typeof fetch
  now?: () => Date
  timeoutMs?: number
}

/** How far back to look for each rate's latest point, and the points' width. */
export const LOOKBACK_HOURS = 6
export const PERIOD_SECONDS = 900

const METRICS = [
  { id: 'bounce', name: 'Reputation.BounceRate' },
  { id: 'complaint', name: 'Reputation.ComplaintRate' },
] as const

export function metricQuery(now: Date) {
  const end = Math.floor(now.getTime() / 1000)
  return {
    MetricDataQueries: METRICS.map((metric) => ({
      Id: metric.id,
      MetricStat: {
        Metric: { Namespace: 'AWS/SES', MetricName: metric.name },
        Period: PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    })),
    StartTime: end - LOOKBACK_HOURS * 3600,
    EndTime: end,
    ScanBy: 'TimestampDescending',
  }
}

/** A rate as a fraction (0.0123) → parts per million (12300), or null. */
export function toPpm(fraction: unknown): number | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) return null
  return Math.min(1_000_000, Math.round(fraction * 1_000_000))
}

/** A CloudWatch timestamp — epoch seconds in JSON, or an ISO string — as ISO, or null. */
function toIso(value: unknown): string | null {
  const at =
    typeof value === 'number'
      ? new Date(value * 1000)
      : typeof value === 'string'
        ? new Date(value)
        : null
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null
}

type Result = { Id?: unknown; Timestamps?: unknown; Values?: unknown }

/** The newest point of one series (CloudWatch orders them as asked: newest first). */
function latest(result: Result | undefined): { value: number | null; at: string | null } {
  const values = Array.isArray(result?.Values) ? result.Values : []
  const stamps = Array.isArray(result?.Timestamps) ? result.Timestamps : []
  let best: { value: number | null; at: string | null; t: number } | null = null
  values.forEach((raw, index) => {
    const value = toPpm(raw)
    const at = toIso(stamps[index])
    if (value === null || at === null) return
    const t = Date.parse(at)
    if (!best || t > best.t) best = { value, at, t }
  })
  const found = best as { value: number | null; at: string | null; t: number } | null
  return found ? { value: found.value, at: found.at } : { value: null, at: null }
}

export function readMetricAnswer(json: unknown): Reading {
  const results = (json as { MetricDataResults?: unknown } | null)?.MetricDataResults
  if (!Array.isArray(results)) return { outcome: 'failed', status: 200, code: 'UnreadableAnswer' }
  const byId = new Map<string, Result>()
  for (const result of results as Result[]) {
    if (typeof result?.Id === 'string') byId.set(result.Id, result)
  }
  const bounce = latest(byId.get('bounce'))
  const complaint = latest(byId.get('complaint'))
  if (bounce.value === null && complaint.value === null) return { outcome: 'no_data' }
  const times = [bounce.at, complaint.at].filter((at): at is string => at !== null).sort()
  return {
    outcome: 'ok',
    bouncePpm: bounce.value,
    complaintPpm: complaint.value,
    metricAt: times.at(-1) ?? null,
  }
}

const errorType = (header: string | null, json: unknown): string | null => {
  const raw = header ?? (json as { __type?: unknown } | null)?.__type
  if (typeof raw !== 'string' || raw === '') return null
  // `com.amazonaws.cloudwatch#AccessDenied:…` → `AccessDenied`; never the message.
  const name = raw.split(':')[0]?.split('#').at(-1) ?? ''
  return /^[A-Za-z0-9_.]{1,60}$/.test(name) ? name : null
}

export async function readAccountReputation(settings: CloudWatchSettings): Promise<Reading> {
  const {
    region,
    accessKeyId,
    secretAccessKey,
    fetch: send = fetch,
    now = () => new Date(),
  } = settings
  const url = `https://monitoring.${region}.amazonaws.com/`
  const body = JSON.stringify(metricQuery(now()))
  const signed = await signRequest(
    {
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'GraniteServiceVersion20100801.GetMetricData',
      },
      body,
    },
    { accessKeyId, secretAccessKey },
    { region, service: 'monitoring' },
    now(),
  )
  let response: Response
  try {
    response = await send(url, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(settings.timeoutMs ?? 15_000),
    })
  } catch {
    return { outcome: 'failed', status: null, code: null }
  }
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) {
    return {
      outcome: 'failed',
      status: response.status,
      code: errorType(response.headers.get('x-amzn-errortype'), json),
    }
  }
  return readMetricAnswer(json)
}
