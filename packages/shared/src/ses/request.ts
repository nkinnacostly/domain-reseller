import { sesErrorType } from './client'
import { type Fetch, type FetchInit, globalFetch, timeoutSignal } from './platform'
import { signRequest, uriEncode } from './sigv4'

/**
 * One signed call to the Amazon SES API v2 (REST + JSON), with our own SigV4
 * — no AWS SDK. Mail's sender (tenant-send.ts) and manager (manage.ts) are
 * built on it. Like the shop's client, an error is described by its HTTP
 * status and SES's error type only: SES's message text can quote an address
 * (N13).
 */

export type SesCredentials = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  fetch?: Fetch
  now?: () => Date
  timeoutMs?: number
}

export type SesCall = {
  method: FetchInit['method']
  /** The path below `/v2/email`, its parameters already encoded (`sesPath`). */
  path: string
  body?: unknown
}

export type SesAnswer =
  | { ok: true; status: number; json: unknown }
  | {
      ok: false
      /** null when SES did not answer. */
      status: number | null
      code: string | null
      /** Throttled, SES unwell, or no answer: the same call may succeed later. */
      retryable: boolean
      error: string
    }

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/

export const sesBaseUrl = (region: string) => `https://email.${region}.amazonaws.com/v2/email`

/** `/identities/acme.ng` — each segment encoded once; SigV4 encodes it again to sign. */
export const sesPath = (...segments: string[]): string =>
  `/${segments.map((segment) => uriEncode(segment)).join('/')}`

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export function assertSesCredentials(settings: SesCredentials): void {
  if (!REGION.test(settings.region)) throw new Error('SES: the region is not an AWS region name')
  if (!settings.accessKeyId || !settings.secretAccessKey)
    throw new Error('SES: credentials are missing')
}

export async function sesCall(settings: SesCredentials, call: SesCall): Promise<SesAnswer> {
  const {
    region,
    accessKeyId,
    secretAccessKey,
    fetch = globalFetch,
    now = () => new Date(),
  } = settings
  const url = `${sesBaseUrl(region)}${call.path}`
  const body = call.body === undefined ? undefined : JSON.stringify(call.body)
  const signed = await signRequest(
    {
      method: call.method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    },
    { accessKeyId, secretAccessKey },
    { region, service: 'ses' },
    now(),
  )

  let status: number
  let text: string
  let errorHeader: string | null
  try {
    const response = await fetch(url, {
      method: call.method,
      headers: signed.headers,
      ...(body === undefined ? {} : { body }),
      signal: timeoutSignal(settings.timeoutMs ?? 15_000),
    })
    status = response.status
    errorHeader = response.headers.get('x-amzn-errortype')
    text = await response.text()
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return {
      ok: false,
      status: null,
      code: null,
      retryable: true,
      error:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'no answer from SES'
          : 'could not reach SES',
    }
  }
  const json = parseJson(text)
  if (status >= 200 && status < 300) return { ok: true, status, json }
  const code = sesErrorType(errorHeader, json)
  return {
    ok: false,
    status,
    code,
    retryable: status === 429 || status >= 500 || code === 'TooManyRequestsException',
    error: `HTTP ${status}${code ? ` ${code}` : ''}`,
  }
}
