import { Bell, PlugsConnected, ShareNetwork } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, StubNotice } from '@/features/api/docs/docs-frame'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Webhooks',
  description:
    'Webhooks send MyDomainsHub Mail’s events to your own server. The guide to them is being written.',
  path: '/docs/webhooks',
})

/**
 * STUB (MAIL-SPEC §6 "Webhook events to customers"): the events package
 * (MB4) built webhooks — endpoints set up in the dashboard — and writes this
 * guide: the events, their signature (Standard Webhooks, MR6), retries, and
 * checking a signature. Until then the page says only what is true now (N9b).
 */
export default function WebhooksPage() {
  return (
    <DocsFrame
      slug="webhooks"
      icons={[Bell, ShareNetwork, PlugsConnected]}
      intro={<p>Events sent to your own server as they happen.</p>}
    >
      <StubNotice>
        <p className="mt-0! font-semibold">This guide is being written.</p>
        <p>
          Webhook endpoints are set up in the dashboard, on the{' '}
          <Link href="/dashboard/webhooks">Webhooks</Link> page. This page will describe the events
          sent, how each request is signed, and how to check it. Until then, an email’s status is
          also in <Link href="/docs/api#getEmail">GET /emails/{'{id}'}</Link>, and questions go to{' '}
          <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>.
        </p>
      </StubNotice>
    </DocsFrame>
  )
}
