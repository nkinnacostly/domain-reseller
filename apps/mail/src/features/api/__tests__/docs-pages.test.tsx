import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ApiPage, { metadata as apiMeta } from '@/app/(marketing)/docs/api/page'
import DomainsPage, { metadata as domainsMeta } from '@/app/(marketing)/docs/domains/page'
import ErrorsPage, { metadata as errorsMeta } from '@/app/(marketing)/docs/errors/page'
import IdempotencyPage, {
  metadata as idempotencyMeta,
} from '@/app/(marketing)/docs/idempotency/page'
import LimitsPage, { metadata as limitsMeta } from '@/app/(marketing)/docs/limits/page'
import DocsIndex, { metadata as indexMeta } from '@/app/(marketing)/docs/page'
import QuickstartPage, { metadata as quickstartMeta } from '@/app/(marketing)/docs/quickstart/page'
import SchedulingPage, { metadata as schedulingMeta } from '@/app/(marketing)/docs/scheduling/page'
import StatusesPage, { metadata as statusesMeta } from '@/app/(marketing)/docs/statuses/page'
import WebhooksPage, { metadata as webhooksMeta } from '@/app/(marketing)/docs/webhooks/page'
import { DOCS_PAGES } from '../docs/pages'

/** Every docs page renders its own h1, and its metadata names its own address. */

vi.mock('next/navigation', () => ({ usePathname: () => '/docs' }))

const PAGES = {
  '/docs': [DocsIndex, indexMeta],
  '/docs/quickstart': [QuickstartPage, quickstartMeta],
  '/docs/api': [ApiPage, apiMeta],
  '/docs/errors': [ErrorsPage, errorsMeta],
  '/docs/limits': [LimitsPage, limitsMeta],
  '/docs/idempotency': [IdempotencyPage, idempotencyMeta],
  '/docs/scheduling': [SchedulingPage, schedulingMeta],
  '/docs/statuses': [StatusesPage, statusesMeta],
  '/docs/webhooks': [WebhooksPage, webhooksMeta],
  '/docs/domains': [DomainsPage, domainsMeta],
} as const

describe('the docs pages', () => {
  it.each(DOCS_PAGES.map((page) => [page.href, page.title] as const))(
    '%s renders with its title and canonical address',
    (href, title) => {
      const [Page, metadata] = PAGES[href as keyof typeof PAGES]
      render(<Page />)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        href === '/docs' ? 'Documentation' : title,
      )
      expect(metadata.alternates?.canonical).toBe(href)
    },
  )

  it('the stubs say plainly that they are not written', () => {
    render(<DomainsPage />)
    expect(screen.getAllByText('This guide is being written.')).toHaveLength(1)
  })

  it('the webhooks guide covers the events, the payload, the signature and the retries', () => {
    render(<WebhooksPage />)
    expect(screen.queryByText('This guide is being written.')).toBeNull()
    for (const name of [
      'Set up an endpoint',
      'The events',
      'The payload',
      'The request',
      'Check the signature',
      'Answers, retries and turning off',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
    for (const label of [
      'Webhook events',
      'Signature headers',
      'A delivery as plain HTTP',
      'Checking a delivery in Node',
      'The signed content',
      'An email.delivered payload',
    ]) {
      expect(screen.getByRole('region', { name: label })).toBeInTheDocument()
    }
    const events = screen.getByRole('region', { name: 'Webhook events' })
    for (const event of [
      'email.sent',
      'email.delivered',
      'email.delivery_delayed',
      'email.bounced',
      'email.complained',
      'email.failed',
      'domain.verified',
      'domain.failed',
    ]) {
      expect(events).toHaveTextContent(event)
    }
    const article = screen.getByRole('article')
    expect(article).toHaveTextContent('24 hours')
    expect(article).toHaveTextContent('3 days')
    expect(article).toHaveTextContent('443 or 8443')
    expect(article).toHaveTextContent('within 10 seconds')
  })

  it('the quickstart shows all four languages', () => {
    render(<QuickstartPage />)
    for (const name of ['curl', 'Node', 'Python', 'PHP']) {
      expect(screen.getByRole('region', { name: `Sending with ${name}` })).toBeInTheDocument()
    }
  })
})
