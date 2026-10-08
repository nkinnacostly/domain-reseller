import { expect as baseExpect, test } from '@playwright/test'
import { Resend } from 'resend'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { apiKeyFor, type ReadyAccount, readyAccount, workAsSender } from './support/mail-api'

/**
 * Resend's official Node SDK, unchanged, against the running app and the
 * real database (MAIL-SPEC §1: a claim of compatibility needs a test that
 * runs that SDK against our API). The unit test (resend-sdk.test.ts) holds
 * each field to what SQL receives; this one shows the whole road: the SDK →
 * Next → SQL → the worker's claim → the log, as /docs/resend tells a
 * developer to set it up — a new key and a base URL.
 *
 * An e2e account in the sandbox, so it sends only to its own member; its
 * domain is under the reserved `.example` TLD. No browser, so one project:
 * the key is made with one programmatic sign-in, and Supabase limits those.
 */

const expect = baseExpect.configure({ timeout: 30_000 })

test.describe('Resend’s SDK, pointed at MyDomainsHub Mail', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 })
  let owner: TestUser
  let account: ReadyAccount
  let resend: Resend
  const stamp = `r${Date.now().toString(36)}`
  let sentId = ''

  test.beforeAll(async ({ baseURL }) => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'no browser: one project is enough')
    owner = await createTestUser('resend', 'Ada Developer')
    account = await readyAccount(owner, `Resend SDK e2e ${stamp}`)
    resend = new Resend(await apiKeyFor(owner, account.accountId), {
      baseUrl: `${baseURL}/api/v1`,
    })
  })

  test.afterAll(async () => {
    if (owner) await deleteTestUser(owner)
  })

  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'no browser: one project is enough')
  })

  const email = () => ({
    from: `Acme <receipts@${account.domain}>`,
    to: owner.email,
    subject: `Your receipt ${stamp}`,
    text: `Thanks, ${stamp}.`,
  })

  test('emails.send queues it, once per Idempotency-Key, with Buffer and inline files', async () => {
    const send = () =>
      resend.emails.send(
        {
          ...email(),
          html: `<p>Thanks, ${stamp}.</p><img src="cid:logo" alt="Acme">`,
          replyTo: owner.email,
          tags: [{ name: 'journey', value: stamp }],
          headers: { 'X-Entity-Ref-ID': stamp },
          attachments: [
            { filename: 'receipt.pdf', content: Buffer.from('%PDF-1.4\n') },
            { filename: 'logo.png', content: 'iVBORw0KGgo=', contentId: 'logo' },
          ],
        },
        { idempotencyKey: `receipt-${stamp}` },
      )
    const first = await send()
    expect(first.error).toBeNull()
    sentId = first.data?.id ?? ''
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await send()).data?.id).toBe(sentId)

    const queued = await resend.emails.get(sentId)
    expect(queued.data).toMatchObject({
      object: 'email',
      id: sentId,
      status: 'queued',
      reply_to: [owner.email],
      tags: [{ name: 'journey', value: stamp }],
    })

    // The worker receives the inline image as one (content_id), the PDF as a file.
    const claimed = await workAsSender(account.accountId, sentId)
    expect(claimed.attachments).toEqual([
      {
        filename: 'receipt.pdf',
        content: Buffer.from('%PDF-1.4\n').toString('base64'),
        content_type: 'application/octet-stream',
      },
      {
        filename: 'logo.png',
        content: 'iVBORw0KGgo=',
        content_type: 'image/png',
        content_id: 'logo',
      },
    ])
    await expect
      .poll(async () => (await resend.emails.get(sentId)).data)
      .toMatchObject({ status: 'delivered', last_event: 'delivery' })
  })

  test('batch.send, emails.list, and a scheduled email moved and canceled', async () => {
    const batch = await resend.batch.send([email(), { ...email(), subject: `Second ${stamp}` }])
    expect(batch.error).toBeNull()
    expect(batch.data?.data).toHaveLength(2)

    const page = await resend.emails.list({ limit: 10 })
    expect(page.error).toBeNull()
    expect(page.data?.data.map((one) => one.id)).toEqual(
      expect.arrayContaining([sentId, ...(batch.data?.data.map((one) => one.id) ?? [])]),
    )

    const inAnHour = new Date(Date.now() + 3_600_000).toISOString()
    const later = await resend.emails.send({ ...email(), scheduledAt: inAnHour })
    const id = later.data?.id ?? ''
    expect((await resend.emails.get(id)).data).toMatchObject({
      status: 'queued',
      scheduled_at: expect.stringMatching(inAnHour.slice(0, 16)),
    })
    const inTwo = new Date(Date.now() + 7_200_000).toISOString()
    expect((await resend.emails.update({ id, scheduledAt: inTwo })).error).toBeNull()
    expect((await resend.emails.cancel(id)).data).toMatchObject({ id, status: 'canceled' })
  })

  test('domains.list and domains.get show the verified domain', async () => {
    const list = await resend.domains.list()
    expect(list.error).toBeNull()
    const mine = list.data?.data.find((one) => one.name === account.domain)
    expect(mine).toMatchObject({ status: 'verified' })
    expect((await resend.domains.get(mine?.id ?? '')).data).toMatchObject({
      object: 'domain',
      name: account.domain,
    })
  })

  test('refusals come back as the SDK’s errors: name, message, statusCode', async () => {
    const unverified = await resend.emails.send({ ...email(), from: 'hi@unverified.example' })
    expect(unverified.data).toBeNull()
    expect(unverified.error).toMatchObject({ name: 'domain_not_verified', statusCode: 403 })

    const permissive = await resend.batch.send([email()], { batchValidation: 'permissive' })
    expect(permissive.error).toMatchObject({ name: 'validation_error', statusCode: 422 })

    const sandbox = await resend.emails.send({ ...email(), to: 'someone@example.com' })
    expect(sandbox.error).toMatchObject({ name: 'forbidden', statusCode: 403 })
  })
})
