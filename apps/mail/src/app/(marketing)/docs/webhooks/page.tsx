import { Bell, PlugsConnected, ShareNetwork } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, StubNotice } from '@/features/api/docs/docs-frame'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Webhooks',
  description:
    'Webhooks for MyDomainsHub Mail are not available yet; this page will describe them.',
  path: '/docs/webhooks',
})

/**
 * STUB (MAIL-SPEC §6 "Webhook events to customers"): the events package
 * builds webhooks and writes this guide — the events, their signature
 * (Standard Webhooks, MR6), retries, and checking a signature. Until then
 * the page says only that they are not here (N9b).
 */
export default function WebhooksPage() {
  return (
    <DocsFrame
      slug="webhooks"
      icons={[Bell, ShareNetwork, PlugsConnected]}
      intro={<p>Events sent to your own server as they happen.</p>}
    >
      <StubNotice>
        <p className="mt-0! font-semibold">Webhooks are not available yet.</p>
        <p>
          This page will describe them once they are: which events are sent, how each request is
          signed, and how to check it. Until then, read an email’s status with{' '}
          <Link href="/docs/api#getEmail">GET /emails/{'{id}'}</Link>, or watch the dashboard’s
          Emails log.
        </p>
      </StubNotice>
    </DocsFrame>
  )
}
