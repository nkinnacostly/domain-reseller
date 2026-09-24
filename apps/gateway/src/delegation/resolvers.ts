import { domainToASCII } from 'node:url'

/**
 * Which nameservers the public internet sees for a domain (PRD FR-D5).
 *
 * The same idea as the storefront's live lookups
 * (apps/web/src/features/domains/queries/dns.ts): ask the big public
 * resolvers, never a cache of our own. Here over DNS-over-HTTPS, so the
 * answer does not depend on the resolver the gateway's host happens to use,
 * with the same short timeout.
 */

export type ResolverView =
  | { resolver: string; state: 'answered'; nameservers: string[] }
  /** The name does not exist: the registry is not publishing the domain. */
  | { resolver: string; state: 'nxdomain' }
  /** The resolver could not get an answer from the domain's nameservers. */
  | { resolver: string; state: 'servfail' }
  /** We could not ask: timeout, network error, or an answer we cannot read. */
  | { resolver: string; state: 'no-answer' }

export type DohResolver = { name: string; url: string }

/** Two independent operators, both serving the JSON form of DoH. */
export const DOH_RESOLVERS: readonly DohResolver[] = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/resolve' },
]

const NS = 2
const NOERROR = 0
const SERVFAIL = 2
const NXDOMAIN = 3

export const normaliseHost = (host: string) => host.trim().toLowerCase().replace(/\.+$/, '')

type DohAnswer = { Status?: unknown; Answer?: unknown }

/** The resolver's JSON answer as a view; anything unexpected is `no-answer`. */
export function readAnswer(resolver: string, domain: string, body: unknown): ResolverView {
  if (typeof body !== 'object' || body === null) return { resolver, state: 'no-answer' }
  const { Status, Answer } = body as DohAnswer
  if (Status === NXDOMAIN) return { resolver, state: 'nxdomain' }
  if (Status === SERVFAIL) return { resolver, state: 'servfail' }
  if (Status !== NOERROR) return { resolver, state: 'no-answer' }

  const owner = normaliseHost(domain)
  const nameservers = new Set<string>()
  for (const record of Array.isArray(Answer) ? Answer : []) {
    if (typeof record !== 'object' || record === null) continue
    const { type, name, data } = record as { type?: unknown; name?: unknown; data?: unknown }
    // Only the domain's own NS records: not a CNAME on the way, not a parent's.
    if (type !== NS || typeof name !== 'string' || typeof data !== 'string') continue
    if (normaliseHost(name) !== owner) continue
    nameservers.add(normaliseHost(data))
  }
  return { resolver, state: 'answered', nameservers: [...nameservers].sort() }
}

export type NsLookup = (domain: string) => Promise<ResolverView[]>

export function createNsLookup(
  options: {
    resolvers?: readonly DohResolver[]
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): NsLookup {
  const { resolvers = DOH_RESOLVERS, fetchImpl = fetch, timeoutMs = 3_000 } = options

  return async function lookup(domain) {
    // An internationalised name is asked for in its ASCII form, as DNS holds it.
    const name = domainToASCII(domain) || domain
    return Promise.all(
      resolvers.map(async (resolver): Promise<ResolverView> => {
        const url = new URL(resolver.url)
        url.searchParams.set('name', name)
        url.searchParams.set('type', 'NS')
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!response.ok) return { resolver: resolver.name, state: 'no-answer' }
          return readAnswer(resolver.name, name, await response.json())
        } catch {
          return { resolver: resolver.name, state: 'no-answer' }
        }
      }),
    )
  }
}
