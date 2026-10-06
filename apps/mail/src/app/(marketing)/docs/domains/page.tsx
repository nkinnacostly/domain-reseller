import { Globe, ListChecks, SealCheck } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, StubNotice } from '@/features/api/docs/docs-frame'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Domains and DNS',
  description:
    'Verifying the domain you send from with MyDomainsHub Mail: the guide is being written.',
  path: '/docs/domains',
})

/**
 * STUB (MAIL-SPEC §5, §6 "DNS set-up per host"): the domains package builds
 * domains and writes this guide — the records, host by host (Cloudflare,
 * Truehost, Hostinger…), and the domains endpoints. Until then the page
 * claims nothing about them (N9b).
 */
export default function DomainsDocsPage() {
  return (
    <DocsFrame
      slug="domains"
      icons={[Globe, ListChecks, SealCheck]}
      intro={<p>Proving to receivers that your email comes from your domain.</p>}
    >
      <StubNotice>
        <p className="mt-0! font-semibold">This guide is being written.</p>
        <p>
          It will list the DNS records a domain needs, and how to add them at the common hosts. You
          send only from a domain verified on your account; the dashboard’s{' '}
          <Link href="/dashboard/domains">Domains</Link> page is where it is added. Questions in the
          meantime: <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>.
        </p>
      </StubNotice>
    </DocsFrame>
  )
}
