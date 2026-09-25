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
    usages: ['sign'],
  ): Promise<HmacKey>
  sign(algorithm: 'HMAC', key: HmacKey, data: Uint8Array): Promise<ArrayBuffer>
}

export type FetchResponse = {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchInit = {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: unknown
}

/** The part of `fetch` the SES client uses; injectable so tests never reach AWS. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>

export type UrlParts = { host: string; pathname: string; search: string }

type Platform = {
  crypto: { subtle: Subtle }
  TextEncoder: new () => { encode(input: string): Uint8Array }
  URL: new (url: string) => UrlParts
  fetch: Fetch
  AbortSignal: { timeout(ms: number): unknown }
}

const platform = globalThis as unknown as Platform

export const subtle = (): Subtle => platform.crypto.subtle

export const utf8 = (input: string): Uint8Array => new platform.TextEncoder().encode(input)

export const parseUrl = (url: string): UrlParts => new platform.URL(url)

export const globalFetch: Fetch = (url, init) => platform.fetch(url, init)

export const timeoutSignal = (ms: number): unknown => platform.AbortSignal.timeout(ms)
