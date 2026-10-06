import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isPublicAddress } from '@dr/shared/mail'

/**
 * How a signed delivery reaches a customer's endpoint (MAIL-SPEC §6, MR6).
 *
 *   - https only, certificates checked (Node's default; never turned off);
 *   - only to public addresses: the name is resolved here and every private,
 *     loopback, link-local or reserved address is dropped before connecting,
 *     so a name that pointed somewhere public when it was saved cannot be
 *     turned on our network later (DNS rebinding). An IP literal is checked
 *     the same way;
 *   - no redirects followed: a 3xx is an answer, not a 2xx;
 *   - 10 seconds for the whole exchange, and at most 2 KB of the answer read,
 *     of which the first 500 characters are kept to show the customer.
 *
 * A failure is a code — timeout, dns_failed, private_address, tls_failed,
 * connection_failed — never the endpoint's own words (they are the answer).
 */

export type Delivery = { url: string; headers: Record<string, string>; body: string }

export type TransportResult = {
  status: number | null
  error: string | null
  response: string | null
  durationMs: number
}

export type Transport = (delivery: Delivery) => Promise<TransportResult>

export const DELIVERY_TIMEOUT_MS = 10_000
const MAX_ANSWER_BYTES = 2_048
const KEPT_ANSWER_CHARS = 500

type Resolve = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

const resolveAll: Resolve = (hostname, callback) => dnsLookup(hostname, { all: true }, callback)

/** A `lookup` for Node's sockets that only ever answers public addresses. */
export function publicOnlyLookup(resolve: Resolve = resolveAll): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) {
        callback(error, '', 4)
        return
      }
      const usable = addresses.filter((address) => isPublicAddress(address.address))
      if (usable.length === 0) {
        const refused: NodeJS.ErrnoException = new Error('no public address')
        refused.code = 'EPRIVATE'
        callback(refused, '', 4)
        return
      }
      if (options.all) {
        ;(callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable)
        return
      }
      const first = usable[0] as LookupAddress
      callback(null, first.address, first.family)
    })
  }
}

const TLS = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_SSL_)/

/** Why a request got no answer, as a code. */
export function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
  if (code === 'EPRIVATE') return 'private_address'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'TIMEOUT') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns_failed'
  if (TLS.test(code)) return 'tls_failed'
  return 'connection_failed'
}

type RequestImpl = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest

export function createTransport({
  request = httpsRequest as RequestImpl,
  lookup = publicOnlyLookup(),
  timeoutMs = DELIVERY_TIMEOUT_MS,
  clock = Date.now,
  allowHttp = false,
}: {
  request?: RequestImpl
  lookup?: LookupFunction
  timeoutMs?: number
  clock?: () => number
  /** Tests only: a plain-http stand-in for a customer's endpoint. */
  allowHttp?: boolean
} = {}): Transport {
  return (delivery) =>
    new Promise((resolve) => {
      const started = clock()
      const done = (result: Omit<TransportResult, 'durationMs'>) =>
        resolve({ ...result, durationMs: Math.max(0, clock() - started) })

      let url: URL
      try {
        url = new URL(delivery.url)
      } catch {
        done({ status: null, error: 'connection_failed', response: null })
        return
      }
      if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
        done({ status: null, error: 'connection_failed', response: null })
        return
      }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicAddress(host)) {
        done({ status: null, error: 'private_address', response: null })
        return
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: Omit<TransportResult, 'durationMs'>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done(result)
      }
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            ...delivery.headers,
            'content-length': String(Buffer.byteLength(delivery.body)),
          },
          lookup,
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          const keep = () => {
            const text = Buffer.concat(chunks).toString('utf8').slice(0, KEPT_ANSWER_CHARS)
            finish({ status: response.statusCode ?? null, error: null, response: text || null })
          }
          response.on('data', (chunk: Buffer) => {
            if (size >= MAX_ANSWER_BYTES) return
            chunks.push(chunk.subarray(0, MAX_ANSWER_BYTES - size))
            size += chunk.length
            if (size >= MAX_ANSWER_BYTES) {
              keep()
              response.destroy()
            }
          })
          response.on('end', keep)
          response.on('error', keep)
        },
      )
      timer = setTimeout(() => {
        finish({ status: null, error: 'timeout', response: null })
        req.destroy()
      }, timeoutMs)
      req.on('error', (error) =>
        finish({ status: null, error: failureCode(error), response: null }),
      )
      req.end(delivery.body)
    })
}
