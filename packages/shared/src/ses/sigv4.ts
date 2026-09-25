import { type HmacKey, parseUrl, subtle, utf8 } from './platform'

/**
 * AWS Signature Version 4, header form, with Web Crypto — no AWS SDK. Proven
 * against AWS's published signing test suite (sigv4.test.ts), not only by
 * round trips through our own code.
 *
 * The secret key never leaves this file: it is only ever an HMAC key.
 */

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string }

export type SigningScope = { region: string; service: string }

export type RequestToSign = {
  method: string
  url: string
  /** Headers to send and sign. `host` comes from the URL and is always signed. */
  headers?: Record<string, string>
  body?: string
}

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'

export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(input: string): Promise<string> {
  return hex(await subtle().digest('SHA-256', utf8(input)))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported: HmacKey = await subtle().importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await subtle().sign('HMAC', imported, utf8(data)))
}

/** `20150830T123600Z` — the request time AWS expects, always UTC. */
export function amzDate(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/**
 * RFC 3986 percent-encoding as SigV4 defines it: everything but
 * `A-Z a-z 0-9 - . _ ~`, hex in upper case, a space as `%20`.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function canonicalPath(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/'
  // Services other than S3 sign each segment of the path as sent, encoded again.
  return pathname
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'))
  } catch {
    return value
  }
}

function canonicalQuery(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (!query) return ''
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=')
      const name = at === -1 ? pair : pair.slice(0, at)
      const value = at === -1 ? '' : pair.slice(at + 1)
      return [uriEncode(decode(name)), uriEncode(decode(value))] as const
    })
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

/** Header values are trimmed and runs of spaces collapsed; names lower-cased and sorted. */
function canonicalHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    block: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  }
}

export type CanonicalRequest = { text: string; signedHeaders: string }

/** The canonical request, for a request whose headers already carry `x-amz-date`. */
export async function canonicalRequest(
  request: RequestToSign & { headers: Record<string, string> },
): Promise<CanonicalRequest> {
  const url = parseUrl(request.url)
  const headers = { ...request.headers, host: url.host }
  const { block, signed } = canonicalHeaders(headers)
  const text = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    block,
    signed,
    await sha256Hex(request.body ?? ''),
  ].join('\n')
  return { text, signedHeaders: signed }
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request"). */
export async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  scope: SigningScope,
): Promise<Uint8Array> {
  const date = await hmac(utf8(`AWS4${secretAccessKey}`), dateStamp)
  const region = await hmac(date, scope.region)
  const service = await hmac(region, scope.service)
  return hmac(service, 'aws4_request')
}

export type Signature = {
  /** The headers to send: the caller's, plus `x-amz-date` and `authorization`. */
  headers: Record<string, string>
  canonicalRequest: string
  stringToSign: string
  signature: string
}

/**
 * Signs a request. The returned headers are the ones to send; `host` is left
 * to the HTTP client, which derives the same value from the URL.
 */
export async function signRequest(
  request: RequestToSign,
  credentials: AwsCredentials,
  scope: SigningScope,
  now: Date = new Date(),
): Promise<Signature> {
  const timestamp = amzDate(now)
  const dateStamp = timestamp.slice(0, 8)
  const headers = { ...request.headers, 'x-amz-date': timestamp }
  const canonical = await canonicalRequest({ ...request, headers })
  const credentialScope = `${dateStamp}/${scope.region}/${scope.service}/aws4_request`
  const stringToSign = [
    SIGV4_ALGORITHM,
    timestamp,
    credentialScope,
    await sha256Hex(canonical.text),
  ].join('\n')
  const key = await signingKey(credentials.secretAccessKey, dateStamp, scope)
  const signature = hex(await hmac(key, stringToSign))
  return {
    headers: {
      ...headers,
      authorization: `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest: canonical.text,
    stringToSign,
    signature,
  }
}
