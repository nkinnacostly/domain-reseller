import { domainToASCII } from 'node:url'
import { DOH_RESOLVERS, type DohResolver, normaliseHost } from '../delegation/resolvers'

/**
 * Does a host preset's nameserver exist in public DNS (PRD FR-D2)? The test
 * FR-D4 applies to typed nameservers: the host must resolve to at least one
 * A or AAAA record. Asked of the same public resolvers as the delegation
 * check, over DNS-over-HTTPS, so the answer never depends on the gateway
 * host's own resolver or a cache of ours.
 */

export type AddressView =
  /** At least one A or AAAA record. */
  | { resolver: string; state: 'resolves'; addresses: string[] }
  /** The name does not exist. */
  | { resolver: string; state: 'nxdomain' }
  /** The name exists, but has neither an A nor an AAAA record. */
  | { resolver: string; state: 'no-address' }
  /** The resolver asked the provider's own nameservers and got nothing back. */
  | { resolver: string; state: 'servfail' }
  /** We could not ask: timeout, network error, or an answer we cannot read. */
  | { resolver: string; state: 'no-answer' }

/** One query's answer (A or AAAA), before the two are put together. */
export type QueryAnswer =
  | { state: 'records'; addresses: string[] }
  | { state: 'nodata' }
  | { state: 'nxdomain' }
  | { state: 'servfail' }
  | { state: 'no-answer' }

const NOERROR = 0
const SERVFAIL = 2
const NXDOMAIN = 3
const RECORD_TYPE = { A: 1, AAAA: 28 } as const
type AddressType = keyof typeof RECORD_TYPE

/**
 * A resolver's JSON answer to an A or AAAA query. Every record of the asked
 * type counts, whoever owns it: a resolver follows a CNAME on the way and
 * returns the target's addresses.
 */
export function readAddresses(type: AddressType, body: unknown): QueryAnswer {
  if (typeof body !== 'object' || body === null) return { state: 'no-answer' }
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown }
  if (Status === NXDOMAIN) return { state: 'nxdomain' }
  if (Status === SERVFAIL) return { state: 'servfail' }
  if (Status !== NOERROR) return { state: 'no-answer' }

  const addresses = new Set<string>()
  for (const record of Array.isArray(Answer) ? Answer : []) {
    if (typeof record !== 'object' || record === null) continue
    const { type: recordType, data } = record as { type?: unknown; data?: unknown }
    if (recordType !== RECORD_TYPE[type] || typeof data !== 'string' || data === '') continue
    addresses.add(data.toLowerCase())
  }
  return addresses.size > 0
    ? { state: 'records', addresses: [...addresses].sort() }
    : { state: 'nodata' }
}

/**
 * One resolver's view of a host, from its A and AAAA answers. An address in
 * either settles it; a missing name settles it the other way. "No address"
 * needs both queries answered — an A answer alone cannot rule out an
 * IPv6-only host.
 */
export function combine(resolver: string, a: QueryAnswer, aaaa: QueryAnswer): AddressView {
  const addresses = [a, aaaa].flatMap((answer) =>
    answer.state === 'records' ? answer.addresses : [],
  )
  if (addresses.length > 0) return { resolver, state: 'resolves', addresses }
  if (a.state === 'nxdomain' || aaaa.state === 'nxdomain') return { resolver, state: 'nxdomain' }
  if (a.state === 'no-answer' || aaaa.state === 'no-answer') return { resolver, state: 'no-answer' }
  if (a.state === 'servfail' && aaaa.state === 'servfail') return { resolver, state: 'servfail' }
  return { resolver, state: 'no-address' }
}

export type AddressLookup = (host: string) => Promise<AddressView[]>

export function createAddressLookup(
  options: {
    resolvers?: readonly DohResolver[]
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): AddressLookup {
  const { resolvers = DOH_RESOLVERS, fetchImpl = fetch, timeoutMs = 3_000 } = options

  async function ask(resolver: DohResolver, name: string, type: AddressType) {
    const url = new URL(resolver.url)
    url.searchParams.set('name', name)
    url.searchParams.set('type', type)
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { state: 'no-answer' } as const
      return readAddresses(type, await response.json())
    } catch {
      return { state: 'no-answer' } as const
    }
  }

  return async function lookup(host) {
    const name = domainToASCII(normaliseHost(host)) || normaliseHost(host)
    return Promise.all(
      resolvers.map(async (resolver) => {
        const [a, aaaa] = await Promise.all([ask(resolver, name, 'A'), ask(resolver, name, 'AAAA')])
        return combine(resolver.name, a, aaaa)
      }),
    )
  }
}
