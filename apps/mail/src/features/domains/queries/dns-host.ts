import 'server-only'

import { env, testEndpoints } from '@/lib/env'
import { CLOUDFLARE_API } from '../lib/cloudflare'
import { PUBLIC_RESOLVERS } from '../lib/dns-check'
import { type DnsHost, findDnsHost, templateSupported } from '../lib/dns-host'
import { fitsTemplate } from '../lib/domain-connect'

/**
 * Whether we can add a domain's records at its DNS host (MAIL-SPEC §5.3):
 * Cloudflare only for now. Live DNS, never cached (CLAUDE.md §15); in the
 * e2e suite, the mock resolver and the mock Cloudflare API (loopback only,
 * refused in production).
 */

export type CloudflareSetup = {
  zone: string
  /** Domain Connect: Cloudflare has our template, we hold the key, and the domain fits it. */
  oneClick: boolean
}

export function cloudflareApiBase(): string {
  return testEndpoints().cloudflare ?? CLOUDFLARE_API
}

export async function dnsHostOf(name: string): Promise<DnsHost> {
  const { doh } = testEndpoints()
  return findDnsHost(name, {
    resolvers: doh ? [{ name: 'Test resolver', url: doh }] : PUBLIC_RESOLVERS,
  })
}

export async function cloudflareSetupFor(domain: {
  name: string
  mailFromDomain: string | null
  dkimTokens: readonly string[]
}): Promise<CloudflareSetup | null> {
  const host = await dnsHostOf(domain.name)
  if (host.provider !== 'cloudflare') return null
  const canSign =
    Boolean(env.MAIL_DOMAIN_CONNECT_PRIVATE_KEY) &&
    domain.dkimTokens.length === 3 &&
    fitsTemplate(domain.name, domain.mailFromDomain)
  const oneClick = canSign && (await templateSupported({ apiBase: cloudflareApiBase() }))
  return { zone: host.zone, oneClick }
}
