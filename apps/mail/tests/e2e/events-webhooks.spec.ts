import { createPrivateKey } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { verifyWebhook, webhookSealKey } from '@dr/shared/webhooks'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createWebhookDeliverer } from '../../../mail-worker/src/webhooks/deliverer'
import { createWebhookStore } from '../../../mail-worker/src/webhooks/store'
import type { Transport } from '../../../mail-worker/src/webhooks/transport'
import { sesEvent, snsNotification } from '../mocks/sns'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { emailStatus, readyAccount, sentEmail, serviceMail } from './support/mail-data'
import {
  E2E_SNS_CERT_URL,
  E2E_SNS_TOPIC_ARN,
  E2E_WEBHOOK_KEY,
  snsKeyFiles,
} from './support/sns-keys'

/**
 * MAIL-SPEC §4.2, §6, §7.5, §10 against the real Supabase project, end to
 * end: an endpoint added and its secret shown once; a signed SNS delivery
 * event moving an email to delivered; the worker's own delivery loop posting
 * the webhook — signed, verified by a local receiver with that secret — and
 * the page showing its answer and resending it; a signed hard bounce
 * suppressing the address, and an owner removing it after the warning. Axe
 * and no sideways scroll on both pages, in both themes.
 *
 * Nothing reaches AWS: the server's SNS certificate fetch is served by a
 * preload with this run's own key (support/sns-preload.mjs), and the
 * account is a test one (`e2e_ready_account`), which never reaches SES and
 * whose webhooks the real worker never takes. The delivery loop here runs for
 * this account only, with a transport that posts to the local receiver.
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3301)
// The local receiver takes a port the system picks, unless one is given: a fixed
// port can be another suite's server (and its readiness checks would land here).
const RECEIVER_PORT = Number(process.env.MAIL_E2E_RECEIVER_PORT ?? 0)
const ENDPOINT = 'https://receiver.mb4-e2e.example/hooks/mail'

const expect = baseExpect.configure({ timeout: 30_000 })
test.use({ reducedMotion: 'reduce' })
const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

async function passesAxe(page: Page, only?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ])
  const results = await (only ? builder.include(only) : builder).analyze()
  expect(results.violations).toEqual([])
}

/** Both themes (S3), every width (S5), and axe in each. */
async function checkPage(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await passesAxe(page)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  const original = page.viewportSize()
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0)
  }
  if (original) await page.setViewportSize(original)
}

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, '\\/')}$`))
}

type Received = { headers: IncomingHttpHeaders; body: string }

test.describe('SES events in, webhooks out, suppressions', () => {
  test.describe.configure({ mode: 'serial' })
  let user: TestUser
  let accountId = ''
  let emailId = ''
  let secret = ''
  let receiver: Server | null = null
  let receiverPort = 0
  const received: Received[] = []
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const messageId = `0102019a-mb4e2e-${tag}-000000`
  const domain = `mb4-${tag}.example`
  const snsKey = () => createPrivateKey(snsKeyFiles(PORT).privatePem())

  /** A signed SNS notification carrying `message`, as AWS would send it here. */
  const signed = (message: unknown) =>
    snsNotification(
      message,
      { TopicArn: E2E_SNS_TOPIC_ARN },
      { key: snsKey(), certUrl: E2E_SNS_CERT_URL },
    )

  /** The worker's delivery loop, once, for this account only, to the local receiver. */
  async function deliver() {
    const toReceiver: Transport = async (delivery) => {
      const started = Date.now()
      const response = await fetch(
        `http://127.0.0.1:${receiverPort}${new URL(delivery.url).pathname}`,
        {
          method: 'POST',
          headers: delivery.headers,
          body: delivery.body,
        },
      )
      const text = await response.text()
      return {
        status: response.status,
        error: null,
        response: text,
        durationMs: Date.now() - started,
      }
    }
    const key = webhookSealKey(E2E_WEBHOOK_KEY)
    if (!key) throw new Error('the e2e sealing key is not 32 bytes')
    const loop = createWebhookDeliverer({
      store: createWebhookStore(serviceMail() as never),
      transport: toReceiver,
      key,
      workerId: `e2e-mb4-webhooks-${tag}`,
      batchSize: 10,
      concurrency: 2,
      pollMs: 1000,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      heartbeat: async () => undefined,
      accountId,
    })
    return loop.runOnce()
  }

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    user = await createTestUser('mb4', 'Ada Webhooks')
    accountId = await readyAccount(user, `Webhooks e2e ${tag}`, domain)
    emailId = await sentEmail(accountId, `Acme <receipts@${domain}>`, user.email, messageId)
    receiver = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        if (req.method === 'POST') received.push({ headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'text/plain' }).end('received, thanks')
      })
    })
    await new Promise<void>((resolve) =>
      receiver?.listen(
        RECEIVER_PORT ? RECEIVER_PORT + test.info().parallelIndex : 0,
        '127.0.0.1',
        resolve,
      ),
    )
    receiverPort = (receiver.address() as AddressInfo).port
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()))
    if (user) await deleteTestUser(user)
  })

  test.beforeEach(() => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
  })

  test('an endpoint is added, and its signing secret shown once (§6, §10)', async ({ page }) => {
    await signIn(page, user, '/dashboard/webhooks')
    await expect(page.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible()
    await expect(page.getByText('No endpoints yet.')).toBeVisible()
    await expect(page.getByText('Nothing has been sent to an endpoint yet.')).toBeVisible()
    await checkPage(page)

    const form = page.getByRole('form', { name: 'Add an endpoint' })
    await form.getByLabel('Endpoint URL').fill('http://receiver.mb4-e2e.example/hooks')
    await form.getByRole('button', { name: 'Add endpoint' }).click()
    await expect(form.getByText(/Use an https:\/\/ address/)).toBeVisible()

    await form.getByLabel('Endpoint URL').fill(ENDPOINT)
    await form.getByLabel('Description (optional)').fill('e2e receiver')
    await form.getByRole('button', { name: 'Add endpoint' }).click()
    const reveal = page.locator('[data-secret-reveal]')
    await expect(reveal.getByText('Endpoint added')).toBeVisible()
    secret = await reveal.getByLabel('Signing secret').inputValue()
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32}$/)
    await checkPage(page)
    await reveal.getByRole('button', { name: 'I have saved it' }).click()
    await expect(page.locator('[data-secret-reveal]')).toHaveCount(0)

    const card = page.locator(`[data-webhook="${ENDPOINT}"]`)
    await expect(card).toContainText('On')
    await expect(card).toContainText(`${secret.slice(0, 10)}…`)
    await expect(card).not.toContainText(secret)
  })

  test('a signed SNS delivery event marks the email delivered (§4.2)', async ({ request }) => {
    const forged = snsNotification(
      sesEvent('Delivery', messageId, { delivery: {} }, { emailId, to: user.email }),
      { TopicArn: E2E_SNS_TOPIC_ARN },
      { certUrl: E2E_SNS_CERT_URL },
    )
    const refused = await request.post('/api/ses/events', {
      data: JSON.stringify(forged),
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
    expect(refused.status()).toBe(403)
    expect(await emailStatus(user, emailId)).toBe('sent')

    const event = sesEvent(
      'Delivery',
      messageId,
      {
        delivery: {
          timestamp: new Date().toISOString(),
          recipients: [user.email],
          smtpResponse: '250 2.0.0 OK',
        },
      },
      { emailId, to: user.email },
    )
    const response = await request.post('/api/ses/events', {
      data: JSON.stringify(signed(event)),
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'x-amz-sns-message-type': 'Notification',
      },
    })
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    await expect.poll(() => emailStatus(user, emailId)).toBe('delivered')
  })

  test('the worker delivers it, signed; the page shows the answer and resends it (§6, MR6)', async ({
    page,
  }) => {
    expect(await deliver()).toMatchObject({ claimed: 1, delivered: 1, failed: 0 })
    expect(received).toHaveLength(1)
    const first = received[0] as Received
    const headers = {
      id: String(first.headers['webhook-id'] ?? ''),
      timestamp: String(first.headers['webhook-timestamp'] ?? ''),
      signature: String(first.headers['webhook-signature'] ?? ''),
    }
    expect(await verifyWebhook(secret, headers, first.body)).toBe(true)
    expect(await verifyWebhook(`whsec_${'A'.repeat(32)}`, headers, first.body)).toBe(false)
    const payload = JSON.parse(first.body)
    expect(payload).toMatchObject({
      type: 'email.delivered',
      data: { email_id: emailId, to: [user.email], subject: 'Your receipt (e2e)' },
    })
    expect(first.body).not.toContain('Thanks for your order')

    await signIn(page, user, '/dashboard/webhooks')
    const table = page.getByRole('table', { name: /Recent webhook deliveries/ })
    await expect(table.getByRole('row')).toHaveCount(2)
    await expect(table).toContainText('Delivered')
    await expect(table).toContainText('HTTP 200')
    await expect(table).toContainText('received, thanks')
    await checkPage(page)

    await table.getByRole('button', { name: /^Resend/ }).click()
    await expect(table.getByRole('button', { name: /^Queued/ })).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole('table', { name: /Recent webhook deliveries/ }).getByRole('row'),
    ).toHaveCount(3)
    await expect(page.getByText('Resent by hand')).toBeVisible()

    expect(await deliver()).toMatchObject({ claimed: 1, delivered: 1 })
    expect(received).toHaveLength(2)
    expect(received[1]?.headers['webhook-id']).toBe(first.headers['webhook-id'])
  })

  test('a signed hard bounce suppresses the address; the owner removes it after a warning (§7.5)', async ({
    page,
    request,
  }) => {
    const bounce = sesEvent(
      'Bounce',
      messageId,
      {
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: user.email, status: '5.1.1', action: 'failed' }],
          timestamp: new Date().toISOString(),
        },
      },
      { emailId, to: user.email },
    )
    const response = await request.post('/api/ses/events', {
      data: JSON.stringify(signed(bounce)),
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
    expect(response.status()).toBe(200)
    await expect.poll(() => emailStatus(user, emailId)).toBe('bounced')

    await signIn(page, user, '/dashboard/suppressions')
    await expect(page.getByRole('heading', { name: 'Suppressions', level: 1 })).toBeVisible()
    const row = page.locator(`[data-suppression="${user.email}"]`)
    await expect(row).toContainText('Bounced')
    await expect(row).toContainText('Amazon SES')
    await checkPage(page)

    const search = page.getByRole('search', { name: 'Find an address' })
    await search.getByLabel('Find an address').fill('nobody@example.com')
    await search.getByRole('button', { name: 'Find' }).click()
    await expect(page.getByText('That address is not on the list')).toBeVisible()
    await page.getByRole('link', { name: 'Show the whole list' }).click()

    await row.getByRole('button', { name: /^Remove/ }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove this address from the list?' })
    await expect(dialog).toContainText('raises your bounce rate')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await passesAxe(page, '[role="alertdialog"]')
    }
    await dialog.getByRole('button', { name: 'Remove from the list' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('No addresses are suppressed.')).toBeVisible()
  })
})
