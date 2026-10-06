import type { EmailRow } from '@dr/shared/mail'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BodyView, HeadersList, Recipients, Timeline } from '../components/email-detail'
import { EmailLog } from '../components/email-log'
import { EmailSearch } from '../components/email-search'
import { readSearch } from '../lib/search'
import { timeline } from '../lib/timeline'
import type { EmailDetail } from '../queries/log'

/** The log and the email page (MAIL-SPEC §10): what each state says, by role and name. */

const ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

const row = (over: Partial<EmailRow> = {}): EmailRow => ({
  id: ID,
  from: 'hello@acme.example',
  to: ['ada@example.com'],
  cc: ['bo@example.com'],
  bcc: [],
  reply_to: [],
  subject: 'Your receipt',
  tags: [],
  status: 'delivered',
  status_reason: null,
  created_at: '2026-10-06T09:00:00.000000Z',
  scheduled_at: '2026-10-06T09:00:00.000000Z',
  sent_at: '2026-10-06T09:00:02.000000Z',
  delivered_at: '2026-10-06T09:00:04.000000Z',
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  last_event: 'delivery',
  last_event_at: '2026-10-06T09:00:04.000000Z',
  ...over,
})

describe('EmailLog', () => {
  it('lists each email with its status in words, subject, recipients and times, linking to its page', () => {
    render(
      <EmailLog
        emails={[
          row(),
          row({
            id: '7a2e4b63-3b1f-4a1c-8e66-1d2f3a4b5c6e',
            status: 'queued',
            subject: 'Later',
            scheduled_at: '2026-10-07T09:00:00.000000Z',
            last_event: null,
            last_event_at: null,
            cc: [],
          }),
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Emails' })
    const [first, second] = within(list).getAllByRole('link')
    expect(first).toHaveAttribute('href', `/dashboard/emails/${ID}`)
    expect(first).toHaveTextContent('Delivered')
    expect(first).toHaveTextContent('To ada@example.com and 1 more')
    expect(first).toHaveTextContent('Queued 6 Oct 2026, 10:00 · delivered 6 Oct 2026, 10:00')
    expect(second).toHaveTextContent('Queued')
    expect(second).toHaveTextContent('Scheduled for 7 Oct 2026, 10:00')
    expect(second).toHaveTextContent('To ada@example.com')
  })
})

describe('EmailSearch', () => {
  it('is a GET form that keeps what was asked, and marks each wrong field', () => {
    render(<EmailSearch search={readSearch({ to: 'nobody', status: 'sent' })} />)
    // <search> is the search landmark (HTML's own element; jsdom's roles predate it).
    const landmark = document.querySelector('search')
    expect(landmark).toHaveAttribute('aria-label', 'Search the email log')
    expect(landmark?.querySelector('form')).toHaveAttribute('method', 'get')
    const to = screen.getByLabelText('Recipient')
    expect(to).toHaveValue('nobody')
    expect(to).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter one whole email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toHaveValue('sent')
    expect(screen.getByRole('link', { name: 'Clear the search' })).toHaveAttribute(
      'href',
      '/dashboard/emails',
    )
  })

  it('offers no clearing when nothing was asked', () => {
    render(<EmailSearch search={readSearch({})} />)
    expect(screen.queryByRole('link', { name: 'Clear the search' })).toBeNull()
    expect(screen.getByLabelText('Recipient')).not.toHaveAttribute('aria-invalid')
  })
})

const detail = (over: Partial<EmailDetail> = {}): EmailDetail => ({
  id: 7,
  public_id: ID,
  from_address: 'Acme <hello@acme.example>',
  to_addresses: ['ada@example.com'],
  cc_addresses: ['bo@example.com'],
  bcc_addresses: ['secret@example.com'],
  reply_to: ['help@acme.example'],
  recipient_count: 3,
  subject: 'Your receipt',
  tags: [{ name: 'kind', value: 'receipt' }],
  status: 'sent',
  status_reason: null,
  ses_message_id: 'ses-message-1',
  created_at: '2026-10-06T09:00:00Z',
  scheduled_at: '2026-10-06T09:00:00Z',
  sent_at: '2026-10-06T09:00:02Z',
  delivered_at: null,
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  ...over,
})

const payload = { html: '<p>Thanks!</p>', text: 'Thanks!', headers: { 'X-Order': '1042' } }

describe('the email page', () => {
  it('draws the timeline with each time, and a bounce’s reason in words', () => {
    render(
      <Timeline
        items={timeline(detail({ status: 'bounced' }), [
          {
            id: 1,
            type: 'bounce',
            occurred_at: '2026-10-06T09:00:05Z',
            detail: { bounceType: 'Permanent', bounceSubType: 'General', diagnosticCode: '550 no' },
          },
        ])}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-event'))).toEqual(['Queued', 'Bounced'])
    expect(items[1]).toHaveTextContent('6 Oct 2026, 10:00:05')
    expect(items[1]).toHaveTextContent('will not take email from you')
    expect(items[1]).toHaveTextContent('The receiving server said: 550 no')
    expect(items[1]).toHaveTextContent('Permanent / General')
  })

  it('lists every recipient, Bcc marked as never in the headers', () => {
    render(<Recipients email={detail()} />)
    expect(screen.getByText('Bcc (not in the headers)')).toBeInTheDocument()
    expect(screen.getByText('secret@example.com')).toBeInTheDocument()
    expect(screen.getByText('help@acme.example')).toBeInTheDocument()
  })

  it('shows the headers we set — never Bcc — and the request’s own while its body is kept', () => {
    const { rerender } = render(<HeadersList email={detail()} payload={payload} />)
    const box = screen.getByRole('region', { name: 'Headers' })
    expect(box).toHaveTextContent('From:Acme <hello@acme.example>')
    expect(box).toHaveTextContent('Reply-To:help@acme.example')
    expect(box).toHaveTextContent('X-Order:1042')
    expect(box).not.toHaveTextContent('secret@example.com')
    expect(screen.getByText('kind: receipt')).toBeInTheDocument()
    expect(screen.getByText('ses-message-1')).toBeInTheDocument()
    rerender(
      <HeadersList
        email={detail({ cc_addresses: [], reply_to: [], tags: [], ses_message_id: null })}
        payload={null}
      />,
    )
    expect(screen.getByRole('region', { name: 'Headers' })).not.toHaveTextContent('Cc:')
    expect(screen.getByText(/kept with the body/)).toBeInTheDocument()
  })

  it('shows the body’s source while kept, and when it goes', () => {
    render(<BodyView email={detail()} payload={payload} memberRole="developer" />)
    expect(
      screen.getByText('Kept until 9 Oct 2026, 10:00, then deleted within the hour.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'The HTML body’s source' })).toHaveTextContent(
      '<p>Thanks!</p>',
    )
    expect(screen.getByRole('region', { name: 'The text body' })).toHaveTextContent('Thanks!')
  })

  it.each([
    [{ status: 'sent' as const }, 'Deleted after 72 hours'],
    [{ status: 'canceled' as const }, 'deleted when it was canceled'],
    [{ status: 'suppressed' as const }, 'never going to be sent'],
  ])('says why there is no body: %j', (over, words) => {
    render(<BodyView email={detail(over)} payload={null} memberRole="owner" />)
    expect(screen.getByText(new RegExp(words))).toBeInTheDocument()
  })

  it('tells a viewer bodies are not theirs to read, and a queued email’s body waits with it', () => {
    const { rerender } = render(<BodyView email={detail()} payload={payload} memberRole="viewer" />)
    expect(screen.getByText(/Viewers cannot read email bodies/)).toBeInTheDocument()
    rerender(
      <BodyView
        email={detail({ status: 'queued', sent_at: null })}
        payload={{ html: null, text: 'Hi', headers: {} }}
        memberRole="admin"
      />,
    )
    expect(
      screen.getByText('Kept until 72 hours after it is sent, then deleted.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'The HTML body’s source' })).toBeNull()
  })
})
