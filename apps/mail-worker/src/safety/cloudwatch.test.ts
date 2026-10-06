import { describe, expect, it, vi } from 'vitest'
import {
  LOOKBACK_HOURS,
  metricQuery,
  PERIOD_SECONDS,
  readAccountReputation,
  readMetricAnswer,
  toPpm,
} from './cloudwatch'

/**
 * The account-wide watch (MAIL-SPEC §7.8): CloudWatch's GetMetricData over
 * the JSON 1.0 protocol, as AWS documents its answer. No test reaches AWS:
 * `fetch` is a double that records what would be sent.
 */

const NOW = new Date('2026-10-06T12:00:00Z')
const settings = {
  region: 'eu-west-2',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'test secret, not a real key',
  now: () => NOW,
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

describe('the query (§7.8)', () => {
  it('asks AWS/SES for both reputation rates over the last hours, newest first', () => {
    const query = metricQuery(NOW)
    expect(query.MetricDataQueries.map((q) => q.MetricStat.Metric)).toEqual([
      { Namespace: 'AWS/SES', MetricName: 'Reputation.BounceRate' },
      { Namespace: 'AWS/SES', MetricName: 'Reputation.ComplaintRate' },
    ])
    expect(query.MetricDataQueries.every((q) => q.MetricStat.Period === PERIOD_SECONDS)).toBe(true)
    expect(query.EndTime - query.StartTime).toBe(LOOKBACK_HOURS * 3600)
    expect(query.EndTime).toBe(NOW.getTime() / 1000)
    expect(query.ScanBy).toBe('TimestampDescending')
  })

  it('turns fractions into parts per million and refuses anything else', () => {
    expect(toPpm(0.0123)).toBe(12_300)
    expect(toPpm(0.00052)).toBe(520)
    expect(toPpm(0)).toBe(0)
    expect(toPpm(3)).toBe(1_000_000)
    expect(toPpm(-0.1)).toBeNull()
    expect(toPpm('0.1')).toBeNull()
    expect(toPpm(Number.NaN)).toBeNull()
  })
})

describe('reading the answer', () => {
  it('takes each rate’s newest point, and the newer of the two times', () => {
    const reading = readMetricAnswer({
      MetricDataResults: [
        {
          Id: 'bounce',
          Timestamps: [1_791_288_000, 1_791_287_100],
          Values: [0.021, 0.019],
          StatusCode: 'Complete',
        },
        {
          Id: 'complaint',
          Timestamps: ['2026-10-06T11:30:00Z', '2026-10-06T11:45:00Z'],
          Values: [0.0004, 0.0006],
          StatusCode: 'Complete',
        },
      ],
      Messages: [],
    })
    expect(reading).toEqual({
      outcome: 'ok',
      bouncePpm: 21_000,
      complaintPpm: 600,
      metricAt: new Date(1_791_288_000 * 1000).toISOString(),
    })
  })

  it('reads one rate without the other, and no points as no data', () => {
    expect(
      readMetricAnswer({
        MetricDataResults: [
          { Id: 'bounce', Timestamps: [1_791_288_000], Values: [0.01] },
          { Id: 'complaint', Timestamps: [], Values: [] },
        ],
      }),
    ).toMatchObject({ outcome: 'ok', bouncePpm: 10_000, complaintPpm: null })
    expect(
      readMetricAnswer({ MetricDataResults: [{ Id: 'bounce', Timestamps: [], Values: [] }] }),
    ).toEqual({ outcome: 'no_data' })
    // A point without its time, or a value that is not a rate, is not a point.
    expect(
      readMetricAnswer({
        MetricDataResults: [{ Id: 'bounce', Timestamps: ['nonsense'], Values: [0.5] }, { Id: 'x' }],
      }),
    ).toEqual({ outcome: 'no_data' })
  })

  it('calls an answer it cannot read a failure', () => {
    expect(readMetricAnswer(null)).toEqual({
      outcome: 'failed',
      status: 200,
      code: 'UnreadableAnswer',
    })
    expect(readMetricAnswer({ MetricDataResults: 'no' })).toMatchObject({ outcome: 'failed' })
  })
})

describe('the call', () => {
  it('signs a JSON 1.0 GetMetricData for the monitoring service, with the sender key', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      answer(200, {
        MetricDataResults: [{ Id: 'bounce', Timestamps: [1_791_288_000], Values: [0.03] }],
      }),
    )
    const reading = await readAccountReputation({
      ...settings,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(reading).toMatchObject({ outcome: 'ok', bouncePpm: 30_000 })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://monitoring.eu-west-2.amazonaws.com/')
    const headers = init?.headers as Record<string, string>
    expect(headers['x-amz-target']).toBe('GraniteServiceVersion20100801.GetMetricData')
    expect(headers['content-type']).toBe('application/x-amz-json-1.0')
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261006\/eu-west-2\/monitoring\/aws4_request, SignedHeaders=/,
    )
    expect(JSON.parse(String(init?.body)).MetricDataQueries).toHaveLength(2)
  })

  it('keeps an AWS refusal to its status and error type, never its words', async () => {
    const refused = vi.fn(async () =>
      answer(400, {
        __type: 'com.amazonaws.cloudwatch#AccessDeniedException',
        message: 'User arn:aws:iam::1:user/x is not allowed',
      }),
    )
    expect(
      await readAccountReputation({ ...settings, fetch: refused as unknown as typeof fetch }),
    ).toEqual({
      outcome: 'failed',
      status: 400,
      code: 'AccessDeniedException',
    })
    const header = vi.fn(async () =>
      answer(403, 'not json', { 'x-amzn-errortype': 'InvalidClientTokenId:http://internal' }),
    )
    expect(
      await readAccountReputation({ ...settings, fetch: header as unknown as typeof fetch }),
    ).toEqual({
      outcome: 'failed',
      status: 403,
      code: 'InvalidClientTokenId',
    })
    const silent = vi.fn(async () => answer(500, ''))
    expect(
      await readAccountReputation({ ...settings, fetch: silent as unknown as typeof fetch }),
    ).toEqual({
      outcome: 'failed',
      status: 500,
      code: null,
    })
  })

  it('calls no answer at all a failure with no status', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(
      await readAccountReputation({ ...settings, fetch: down as unknown as typeof fetch }),
    ).toEqual({
      outcome: 'failed',
      status: null,
      code: null,
    })
  })
})
