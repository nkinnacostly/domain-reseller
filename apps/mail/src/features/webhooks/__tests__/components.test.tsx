import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWebhook,
  deleteWebhook,
  resendDelivery,
  rotateWebhookSecret,
  setWebhookEnabled,
  updateWebhook,
} from '../actions/webhooks'
import { DeliveriesTable } from '../components/deliveries-table'
import { ResendButton } from '../components/resend-button'
import { WebhookCard } from '../components/webhook-card'
import { WebhookForm } from '../components/webhook-form'
import type { Delivery, Webhook } from '../queries/webhooks'

/**
 * The Webhooks page's parts (MAIL-SPEC §10): adding and changing an endpoint,
 * its secret shown once, turning it off, a new secret, deleting, and the
 * deliveries with their answers and "Resend".
 */

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('../actions/webhooks', () => ({
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  setWebhookEnabled: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  deleteWebhook: vi.fn(),
  resendDelivery: vi.fn(),
}))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const SECRET = 'whsec_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

const webhook: Webhook = {
  id: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
  url: 'https://hooks.acme.example/mail',
  description: 'Production',
  events: ['email.delivered', 'email.bounced'],
  secretHint: 'whsec_AbCd',
  status: 'enabled',
  disabledReason: null,
  disabledAt: null,
  failingSince: null,
  lastSuccessAt: '2026-10-06T08:00:00Z',
  createdAt: '2026-10-01T08:00:00Z',
}

const delivery: Delivery = {
  id: 41,
  webhookId: webhook.id,
  messageId: `msg_${'a'.repeat(32)}`,
  eventType: 'email.delivered',
  payload: { type: 'email.delivered', data: { email_id: 'e-1' } },
  status: 'delivered',
  statusReason: null,
  attempts: 2,
  nextAttemptAt: '2026-10-06T08:00:00Z',
  lastAttemptAt: '2026-10-06T08:00:00Z',
  lastStatusCode: 200,
  lastError: null,
  lastResponse: 'thanks',
  lastDurationMs: 120,
  history: [
    { at: '2026-10-06T07:59:00Z', status: 500, error: 'http_status', ms: 40 },
    { at: '2026-10-06T08:00:00Z', status: 200, error: null, ms: 120 },
  ],
  resendOf: null,
  createdAt: '2026-10-06T07:59:00Z',
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => vi.clearAllMocks())

describe('WebhookForm', () => {
  it('sends the address, a description and the ticked events, then shows the secret once', async () => {
    answer(createWebhook, { data: { secret: SECRET, webhookId: webhook.id } })
    const user = userEvent.setup()
    render(<WebhookForm accountId={ACCOUNT} />)
    const form = screen.getByRole('form', { name: 'Add an endpoint' })
    await user.type(within(form).getByLabelText('Endpoint URL'), 'https://hooks.acme.example/mail')
    await user.type(within(form).getByLabelText('Description (optional)'), 'Production')
    await user.click(within(form).getByRole('checkbox', { name: /Marked as spam/ }))
    await user.click(within(form).getByRole('checkbox', { name: /Domain verified/ }))
    await user.click(within(form).getByRole('button', { name: 'Add endpoint' }))
    expect(createWebhook).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      url: 'https://hooks.acme.example/mail',
      description: 'Production',
      events: ['email.delivered', 'email.bounced', 'domain.verified'],
    })
    expect(await screen.findByDisplayValue(SECRET)).toBeInTheDocument()
    expect(screen.getByText(/cannot show it again/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Add an endpoint' })).toBeInTheDocument()
  })

  it('shows what was refused, by field and in words', async () => {
    answer(createWebhook, {
      validationErrors: {
        url: { _errors: ['Use an https:// address'] },
        events: { _errors: ['Choose at least one event.'] },
      },
    })
    const user = userEvent.setup()
    render(<WebhookForm accountId={ACCOUNT} />)
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect(await screen.findByText('Use an https:// address')).toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint URL')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Choose at least one event.')).toBeInTheDocument()
    answer(createWebhook, { data: { error: 'This account has 10 endpoints.' } })
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect(await screen.findByText('This account has 10 endpoints.')).toBeInTheDocument()
  })

  it('edits an endpoint with what it has, and closes when saved or cancelled', async () => {
    answer(updateWebhook, { data: { ok: true } })
    const done = vi.fn()
    const user = userEvent.setup()
    render(<WebhookForm accountId={ACCOUNT} webhook={webhook} onDone={done} />)
    const form = screen.getByRole('form', { name: `Change ${webhook.url}` })
    expect(within(form).getByLabelText('Endpoint URL')).toHaveValue(webhook.url)
    expect(within(form).getByRole('checkbox', { name: /^Bounced/ })).toBeChecked()
    expect(within(form).getByRole('checkbox', { name: /Marked as spam/ })).not.toBeChecked()
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))
    expect(updateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: webhook.id,
        events: ['email.delivered', 'email.bounced'],
      }),
    )
    expect(done).toHaveBeenCalled()
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(done).toHaveBeenCalledTimes(2)
  })
})

describe('WebhookCard', () => {
  it('shows the endpoint’s state, events and secret hint; a viewer gets no buttons', () => {
    render(
      <ul>
        <WebhookCard accountId={ACCOUNT} webhook={webhook} canManage={false} />
      </ul>,
    )
    expect(screen.getByText(webhook.url)).toBeInTheDocument()
    expect(screen.getByText('On')).toBeInTheDocument()
    expect(screen.getByText('whsec_AbCd…')).toBeInTheDocument()
    expect(screen.getByText('Delivered')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    [{ failingSince: '2026-10-05T08:00:00Z' }, 'On, failing', /turned off/],
    [
      {
        status: 'disabled' as const,
        disabledReason: 'failing' as const,
        disabledAt: '2026-10-06T08:00:00Z',
      },
      'Off: kept failing',
      /nothing but errors for three days/,
    ],
    [
      {
        status: 'disabled' as const,
        disabledReason: 'customer' as const,
        disabledAt: '2026-10-06T08:00:00Z',
      },
      'Off',
      /Turned off/,
    ],
  ])('says how it is doing (%o)', (over, label, words) => {
    render(
      <ul>
        <WebhookCard accountId={ACCOUNT} webhook={{ ...webhook, ...over }} canManage />
      </ul>,
    )
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText(words)).toBeInTheDocument()
  })

  it('turns it off, makes a new secret after a warning, and deletes after another', async () => {
    answer(setWebhookEnabled, { data: { error: 'This account is closed.' } })
    answer(rotateWebhookSecret, { data: { secret: SECRET } })
    answer(deleteWebhook, { data: { ok: true } })
    const user = userEvent.setup()
    render(
      <ul>
        <WebhookCard accountId={ACCOUNT} webhook={webhook} canManage />
      </ul>,
    )
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(setWebhookEnabled).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      webhookId: webhook.id,
      enabled: false,
    })
    expect(await screen.findByText('This account is closed.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New secret' }))
    const rotate = await screen.findByRole('alertdialog', { name: 'Make a new signing secret?' })
    await user.click(within(rotate).getByRole('button', { name: 'Make a new secret' }))
    expect(rotateWebhookSecret).toHaveBeenCalledWith({ accountId: ACCOUNT, webhookId: webhook.id })
    expect(await screen.findByDisplayValue(SECRET)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const remove = await screen.findByRole('alertdialog', { name: 'Delete this endpoint?' })
    await user.click(within(remove).getByRole('button', { name: 'Delete the endpoint' }))
    expect(deleteWebhook).toHaveBeenCalledWith({ accountId: ACCOUNT, webhookId: webhook.id })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('opens the edit form in place', async () => {
    const user = userEvent.setup()
    render(
      <ul>
        <WebhookCard accountId={ACCOUNT} webhook={webhook} canManage />
      </ul>,
    )
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('form', { name: `Change ${webhook.url}` })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })
})

describe('DeliveriesTable and ResendButton', () => {
  it('lists each delivery with its state, answer, attempts and payload', () => {
    render(
      <DeliveriesTable
        accountId={ACCOUNT}
        deliveries={[
          delivery,
          {
            ...delivery,
            id: 42,
            webhookId: 'gone',
            status: 'failed',
            statusReason: 'gave_up',
            resendOf: 41,
          },
          { ...delivery, id: 43, status: 'pending', attempts: 0, history: [] },
          { ...delivery, id: 44, status: 'pending', attempts: 1, history: [] },
        ]}
        webhooks={[webhook]}
        canManage
      />,
    )
    const table = screen.getByRole('table', { name: /Recent webhook deliveries/ })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(5)
    expect(within(rows[3] as HTMLElement).getByText('Queued')).toBeInTheDocument()
    expect(within(rows[3] as HTMLElement).getByText('Not tried yet')).toBeInTheDocument()
    expect(within(rows[4] as HTMLElement).getByText('Waiting to retry')).toBeInTheDocument()
    expect(within(rows[4] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('HTTP 200 in 120 ms')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('thanks')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('2 attempts')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('hooks.acme.example')).toBeInTheDocument()
    expect(
      within(rows[1] as HTMLElement).getByRole('button', { name: /Resend/ }),
    ).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('A deleted endpoint')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText(/Gave up after 24 hours/)).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('Resent by hand')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  it('resends, says it is queued, and shows a refusal', async () => {
    answer(resendDelivery, { data: { ok: true } })
    const user = userEvent.setup()
    const { unmount } = render(
      <ResendButton accountId={ACCOUNT} deliveryId={41} label="the Delivered event" />,
    )
    await user.click(screen.getByRole('button', { name: 'Resend: the Delivered event' }))
    expect(resendDelivery).toHaveBeenCalledWith({ accountId: ACCOUNT, deliveryId: 41 })
    expect(await screen.findByRole('button', { name: /Queued/ })).toBeDisabled()
    unmount()
    answer(resendDelivery, { data: { error: 'That delivery is still being tried.' } })
    render(<ResendButton accountId={ACCOUNT} deliveryId={41} label="x" />)
    await user.click(screen.getByRole('button', { name: /Resend/ }))
    expect(await screen.findByText('That delivery is still being tried.')).toBeInTheDocument()
  })
})
