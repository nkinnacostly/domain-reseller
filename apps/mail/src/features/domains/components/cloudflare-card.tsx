import type { DnsRecord } from '../lib/records'
import { cloudflareSetupFor } from '../queries/dns-host'
import { CloudflareSetup } from './cloudflare-setup'

/**
 * Asks public DNS where the domain's zone is, and offers "Add to Cloudflare"
 * when it is there (MAIL-SPEC §5.3). Rendered inside Suspense with no
 * fallback: it adds a shortcut to a page that is whole without it, so while
 * DNS answers, when it cannot, or when the zone is elsewhere, the page shows
 * the records and the host guides as before.
 */
export async function CloudflareCard({
  accountId,
  domain,
  canManage,
  records,
}: {
  accountId: string
  domain: { id: string; name: string; mailFromDomain: string | null; dkimTokens: string[] }
  canManage: boolean
  records: DnsRecord[]
}) {
  let setup: Awaited<ReturnType<typeof cloudflareSetupFor>>
  try {
    setup = await cloudflareSetupFor(domain)
  } catch {
    return null
  }
  if (!setup) return null
  return (
    <CloudflareSetup
      accountId={accountId}
      domainId={domain.id}
      zone={setup.zone}
      oneClick={setup.oneClick}
      canManage={canManage}
      records={records}
    />
  )
}
