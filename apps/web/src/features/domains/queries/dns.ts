import 'server-only'

import { Resolver } from 'node:dns/promises'
import type { HostLookup } from '../lib/nameserver-check'

/**
 * Live DNS, as the public internet sees it (PRD FR-D4, FR-D6, FR-N4).
 *
 * We do not host DNS (ADR-001), so everything here is read-only: we ask the
 * big public resolvers what they see, never our own infrastructure's cache.
 */

export const PUBLIC_RESOLVERS = [
  { name: 'Cloudflare', address: '1.1.1.1' },
  { name: 'Google', address: '8.8.8.8' },
  { name: 'Quad9', address: '9.9.9.9' },
] as const

function resolver(address: string): Resolver {
  const instance = new Resolver({ timeout: 3_000, tries: 1 })
  instance.setServers([address])
  return instance
}

const code = (err: unknown) => (err as { code?: string }).code

/** Does this nameserver host exist? FR-D4: it must resolve to A or AAAA. */
export async function lookupHost(host: string): Promise<HostLookup> {
  const dns = resolver(PUBLIC_RESOLVERS[0].address)
  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)])
  if (v4.status === 'fulfilled' || v6.status === 'fulfilled') return 'resolves'
  const codes = [v4, v6].map((result) =>
    result.status === 'rejected' ? code(result.reason) : null,
  )
  return codes.includes('ENOTFOUND') ? 'nxdomain' : 'no-answer'
}

export type ResolverView =
  | { resolver: string; state: 'answered'; nameservers: string[] }
  | { resolver: string; state: 'nxdomain' }
  | { resolver: string; state: 'no-answer' }

/** FR-D6 — which nameservers each public resolver currently sees. */
export async function delegationViews(domain: string): Promise<ResolverView[]> {
  return Promise.all(
    PUBLIC_RESOLVERS.map(async ({ name, address }): Promise<ResolverView> => {
      try {
        const nameservers = (await resolver(address).resolveNs(domain))
          .map((ns) => ns.toLowerCase())
          .sort()
        return { resolver: name, state: 'answered', nameservers }
      } catch (err) {
        return { resolver: name, state: code(err) === 'ENOTFOUND' ? 'nxdomain' : 'no-answer' }
      }
    }),
  )
}

export type DnsInspection = {
  a: string[]
  aaaa: string[]
  cname: string[]
  mx: { exchange: string; priority: number }[]
  txt: string[]
  caa: string[]
  exists: boolean
}

/**
 * FR-N4 — read-only inspection: what anyone looking up this domain gets. It
 * answers "why isn't my email working?" without a screenshot.
 */
export async function inspectDns(domain: string): Promise<DnsInspection> {
  const dns = resolver(PUBLIC_RESOLVERS[0].address)
  const settle = async <T>(
    query: Promise<T>,
    fallback: T,
  ): Promise<{ value: T; missing: boolean }> => {
    try {
      return { value: await query, missing: false }
    } catch (err) {
      return { value: fallback, missing: code(err) === 'ENOTFOUND' }
    }
  }

  const [a, aaaa, cname, mx, txt, caa] = await Promise.all([
    settle(dns.resolve4(domain), [] as string[]),
    settle(dns.resolve6(domain), [] as string[]),
    settle(dns.resolveCname(domain), [] as string[]),
    settle(dns.resolveMx(domain), [] as { exchange: string; priority: number }[]),
    settle(dns.resolveTxt(domain), [] as string[][]),
    settle(
      dns.resolveCaa(domain),
      [] as { critical: number; issue?: string; issuewild?: string; iodef?: string }[],
    ),
  ])

  return {
    a: a.value,
    aaaa: aaaa.value,
    cname: cname.value,
    mx: [...mx.value].sort((x, y) => x.priority - y.priority),
    txt: txt.value.map((chunks) => chunks.join('')),
    caa: caa.value.map((record) =>
      record.issue !== undefined
        ? `issue "${record.issue}"`
        : record.issuewild !== undefined
          ? `issuewild "${record.issuewild}"`
          : `iodef "${record.iodef ?? ''}"`,
    ),
    // Every query said "no such name": the domain is not in DNS at all.
    exists: ![a, aaaa, cname, mx, txt, caa].every((result) => result.missing),
  }
}
