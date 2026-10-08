import { SMTP_SETTINGS } from '@dr/shared/mail'
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
import ResendPage, { metadata as resendMeta } from '@/app/(marketing)/docs/resend/page'
import SchedulingPage, { metadata as schedulingMeta } from '@/app/(marketing)/docs/scheduling/page'
import SmtpPage, { metadata as smtpMeta } from '@/app/(marketing)/docs/smtp/page'
import StatusesPage, { metadata as statusesMeta } from '@/app/(marketing)/docs/statuses/page'
import WebhooksPage, { metadata as webhooksMeta } from '@/app/(marketing)/docs/webhooks/page'
import mailPackage from '../../../../package.json'
import { DOCS_PAGES } from '../docs/pages'
import { RESEND_SDK_TESTED } from '../docs/resend'

/** Every docs page renders its own h1, and its metadata names its own address. */

vi.mock('next/navigation', () => ({ usePathname: () => '/docs' }))

const PAGES = {
  '/docs': [DocsIndex, indexMeta],
  '/docs/quickstart': [QuickstartPage, quickstartMeta],
  '/docs/smtp': [SmtpPage, smtpMeta],
  '/docs/resend': [ResendPage, resendMeta],
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

  it('the Resend guide names the SDK version the tests run, and nothing else as tested', () => {
    // resend-sdk.test.ts runs the package pinned here, exactly: the page must name that one (N9b).
    expect(mailPackage.devDependencies.resend).toBe(RESEND_SDK_TESTED)
    render(<ResendPage />)
    expect(
      screen.getByText(new RegExp(`version ${RESEND_SDK_TESTED.replace(/\./g, '\\.')}`)),
    ).toBeInTheDocument()
    for (const name of [
      'Before you switch',
      'Point the SDK here',
      'What works',
      'What is different',
      'Error names',
      'Other languages',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
    const works = screen.getByRole('region', { name: 'Resend SDK calls that work here' })
    for (const call of ['emails.send', 'batch.send', 'emails.get', 'webhooks.verify']) {
      expect(works).toHaveTextContent(call)
    }
    expect(screen.getByText(/not affiliated with Resend/)).toBeInTheDocument()
  })

  it('the SMTP guide gives the relay’s own settings, samples and replies', () => {
    render(<SmtpPage />)
    const settings = screen.getByRole('region', { name: 'SMTP settings' })
    for (const value of [
      SMTP_SETTINGS.host,
      '465, or 2465',
      SMTP_SETTINGS.username,
      'STARTTLS is not offered',
    ]) {
      expect(settings).toHaveTextContent(value)
    }
    for (const label of [
      'Node.js (Nodemailer)',
      'Laravel (.env)',
      'Django (settings.py)',
      'PHP (PHPMailer)',
    ]) {
      expect(screen.getByRole('region', { name: label })).toHaveTextContent(SMTP_SETTINGS.host)
    }
    expect(screen.getByRole('region', { name: 'SMTP replies' })).toHaveTextContent('Queued as')
    expect(screen.getByText(/7 MB a message/)).toBeInTheDocument()
  })

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
