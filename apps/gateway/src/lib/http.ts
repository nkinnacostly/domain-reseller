import { request as httpsRequest } from 'node:https'

/**
 * JSON GET over HTTP/1.1.
 *
 * Node's fetch negotiates HTTP/2, which trips a TLS "bad record mac" against
 * the supplier's host. node:https stays on 1.1 and works everywhere.
 */
export function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers: { Accept: 'application/json', ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

/** The request may or may not have reached the other side: a timeout or a dropped connection. */
export class NoAnswer extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoAnswer'
  }
}

export type JsonResponse = { status: number; body: unknown }

/**
 * A JSON request over HTTP/1.1 (see getJson for why not fetch). Any HTTP
 * status resolves — the caller decides what a 400 means — and only "no
 * answer" rejects, as NoAnswer, because for a money call that is the one case
 * where nobody knows what happened (I2).
 */
export function requestJson(
  url: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
  } = {},
): Promise<JsonResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = init
  const payload = body === undefined ? undefined : JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', (error) => reject(new NoAnswer(error.message)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', (error) => reject(new NoAnswer(error.message)))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}
