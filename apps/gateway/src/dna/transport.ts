import { AsyncLocalStorage } from 'node:async_hooks'
import type { DnaHttpRequest, DnaHttpResponse } from 'nodejs-dna'

/**
 * The HTTP layer under the supplier SDK.
 *
 * nodejs-dna 3.0.0 has three habits we cannot accept on a path that spends
 * money, all in its REST client (read 23 Sept 2026):
 *
 * 1. It turns TLS certificate checking off (`rejectUnauthorized: false`)
 *    while sending our API key in a header.
 * 2. On a timeout or dropped connection it returns an empty object, which
 *    `ModifyNameServer` reports as success and `GetDetails` as a generic
 *    error — a timeout must be *unknown*, never either (I2).
 * 3. For an HTTP error it keeps only the status, dropping the supplier's own
 *    error code and message.
 *
 * So the SDK builds each request (its payload mapping is the vendor's), and
 * this sends it: certificates checked, and every exchange recorded where the
 * caller can see it — per call, even with calls running side by side.
 */

export type Exchange = {
  method: string
  path: string
  /** Null when no response arrived: timeout or network failure. */
  status: number | null
  networkError: string | null
  body: unknown
  ms: number
}

const recorder = new AsyncLocalStorage<Exchange[]>()

/** Runs `task` and returns the HTTP exchanges it made, alongside its result. */
export async function withExchanges<T>(
  task: () => Promise<T>,
): Promise<{ result: T; exchanges: Exchange[] }> {
  const exchanges: Exchange[] = []
  const result = await recorder.run(exchanges, task)
  return { result, exchanges }
}

function networkErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'TIMEOUT'
    const cause = (error as { cause?: { code?: unknown } }).cause
    if (cause && typeof cause.code === 'string') return cause.code
  }
  return 'NETWORK'
}

/** An axios-compatible callable for the SDK's REST client (`client._axios`). */
export function createTransport(fetchImpl: typeof fetch = fetch) {
  return async function send(config: DnaHttpRequest): Promise<DnaHttpResponse> {
    const started = Date.now()
    const url = new URL(config.url)
    for (const [key, value] of Object.entries(config.params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const method = config.method.toUpperCase()
    const exchange: Exchange = {
      method,
      path: url.pathname,
      status: null,
      networkError: null,
      body: undefined,
      ms: 0,
    }
    recorder.getStore()?.push(exchange)

    try {
      const response = await fetchImpl(url, {
        method,
        headers: config.headers,
        ...(config.data === undefined ? {} : { body: JSON.stringify(config.data) }),
        // The SDK reads a 301/302 as bad credentials; following it would hide that.
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeout ?? 30_000),
      })
      const text = await response.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { raw_response: text }
      }
      exchange.status = response.status
      exchange.body = data
      exchange.ms = Date.now() - started
      return { status: response.status, data, headers: Object.fromEntries(response.headers) }
    } catch (error) {
      exchange.networkError = networkErrorCode(error)
      exchange.ms = Date.now() - started
      throw error
    }
  }
}
