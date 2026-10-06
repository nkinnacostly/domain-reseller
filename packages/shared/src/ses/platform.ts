/**
 * The few Web Platform globals this module needs — Web Crypto, TextEncoder,
 * fetch and AbortSignal — typed here rather than through the DOM library:
 * `packages/shared` compiles without DOM types on purpose, and both runtimes
 * that load this module (Node 22+ in the gateway, Node on Vercel) have them.
 */

export type HmacKey = { readonly type: string }

type Subtle = {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: false,
    usages: ['sign'] | ['verify'],
  ): Promise<HmacKey>
  sign(algorithm: 'HMAC', key: HmacKey, data: Uint8Array): Promise<ArrayBuffer>
  /** Constant-time comparison of an HMAC: how a webhook signature is checked. */
  verify(algorithm: 'HMAC', key: HmacKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>
}

export type FetchResponse = {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchInit = {
  /** SendEmail and creations are POSTs; Mail's management calls also GET, PUT and DELETE. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers: Record<string, string>
  /** Absent on a GET or DELETE. */
  body?: string
  signal?: unknown
}

/** The part of `fetch` the SES client uses; injectable so tests never reach AWS. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>

export type UrlParts = { host: string; pathname: string; search: string }

type Platform = {
  crypto: { subtle: Subtle; getRandomValues<T extends Uint8Array>(array: T): T }
  TextEncoder: new () => { encode(input: string): Uint8Array }
  URL: new (url: string) => UrlParts
  fetch: Fetch
  AbortSignal: { timeout(ms: number): unknown }
}

const platform = globalThis as unknown as Platform

export const subtle = (): Subtle => platform.crypto.subtle

export const utf8 = (input: string): Uint8Array => new platform.TextEncoder().encode(input)

/** Cryptographically random bytes: API keys, webhook secrets, MIME boundaries. */
export const randomBytes = (length: number): Uint8Array =>
  platform.crypto.getRandomValues(new Uint8Array(length))

export const parseUrl = (url: string): UrlParts => new platform.URL(url)

export const globalFetch: Fetch = (url, init) => platform.fetch(url, init)

export const timeoutSignal = (ms: number): unknown => platform.AbortSignal.timeout(ms)
