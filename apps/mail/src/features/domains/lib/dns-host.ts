import { zoneCandidates } from './cloudflare'
import type { DohResolver } from './dns-check'
import { DOMAIN_CONNECT } from './domain-connect'

/**
 * Which DNS host serves a domain (MAIL-SPEC §5.3), from its nameservers in
 * public DNS, asked live like every DNS view here (CLAUDE.md §15). The
 * nearest name with NS records is the zone: for mail.example.com that is
 * usually example.com. A zone whose nameservers are all Cloudflare's
 * (*.ns.cloudflare.com, the names Cloudflare assigns every zone) is on
 * Cloudflare. A resolver we could not ask says nothing either way.
 */

export type DnsHost =
  | { provider: 'cloudflare'; zone: string }
  | { provider: 'other'; zone: string }
  | { provider: 'unknown' }

const NS = 2
const CLOUDFLARE_NS = /\.ns\.cloudflare\.com\.?$/i

const normalise = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '')

type Asked = { answered: false } | { answered: true; nameservers: string[] }

/** One resolver's NS records owned by exactly this name. */
export function readNameservers(name: string, body: unknown): Asked {
  if (typeof body !== 'object' || body === null) return { answered: false }
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown }
  // NXDOMAIN: the name has no records yet, which still says where to look next.
  if (Status === 3) return { answered: true, nameservers: [] }
  if (Status !== 0) return { answered: false }
  const nameservers: string[] = []
  for (const item of Array.isArray(Answer) ? Answer : []) {
    if (typeof item !== 'object' || item === null) continue
    const { name: owner, type, data } = item as { name?: unknown; type?: unknown; data?: unknown }
    if (type !== NS || typeof owner !== 'string' || typeof data !== 'string') continue
    if (normalise(owner) === normalise(name)) nameservers.push(normalise(data))
  }
  return { answered: true, nameservers }
}

export async function findDnsHost(
  name: string,
  {
    resolvers,
    fetchImpl = fetch,
    timeoutMs = 3_000,
  }: { resolvers: readonly DohResolver[]; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<DnsHost> {
  async function ask(candidate: string): Promise<Asked> {
    for (const resolver of resolvers) {
      const url = new URL(resolver.url)
      url.searchParams.set('name', candidate)
      url.searchParams.set('type', 'NS')
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
        })
        if (!response.ok) continue
        const asked = readNameservers(candidate, await response.json())
        if (asked.answered) return asked
      } catch {
        // The next resolver, if any.
      }
    }
    return { answered: false }
  }

  for (const candidate of zoneCandidates(name)) {
    const asked = await ask(candidate)
    if (!asked.answered) return { provider: 'unknown' }
    if (asked.nameservers.length === 0) continue
    const cloudflare = asked.nameservers.every((ns) => CLOUDFLARE_NS.test(ns))
    return { provider: cloudflare ? 'cloudflare' : 'other', zone: candidate }
  }
  return { provider: 'unknown' }
}

/**
 * Whether Cloudflare has taken on our Domain Connect template yet: 200 once
 * it has, 404 until then (seen 8 Oct 2026). Anything else counts as no, so
 * the customer is offered the token way instead.
 */
export async function templateSupported({
  apiBase,
  fetchImpl = fetch,
  timeoutMs = 3_000,
}: {
  apiBase: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<boolean> {
  const { providerId, serviceId, cloudflare } = DOMAIN_CONNECT
  try {
    const response = await fetchImpl(
      `${apiBase}${cloudflare.apiPath}/v2/domainTemplates/providers/${providerId}/services/${serviceId}`,
      { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' },
    )
    return response.status === 200
  } catch {
    return false
  }
}
