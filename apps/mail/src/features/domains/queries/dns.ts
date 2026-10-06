import 'server-only'

import { testEndpoints } from '@/lib/env'
import { createDnsLookup, type DnsLookup, PUBLIC_RESOLVERS } from '../lib/dns-check'

/**
 * Live DNS for the domains page and the job route (CLAUDE.md §15: DNS views
 * are live lookups against public resolvers, never cached): Cloudflare and
 * Google over DNS-over-HTTPS — or, in the e2e suite only, the mock resolver
 * at MAIL_DOH_URL (loopback, refused in production).
 */
export function dnsLookup(): DnsLookup {
  const { doh } = testEndpoints()
  return createDnsLookup({
    resolvers: doh ? [{ name: 'Test resolver', url: doh }] : PUBLIC_RESOLVERS,
  })
}
