import { describe, expect, it, vi } from 'vitest'
import { NoAnswer } from '../lib/http'
import { createBrevo, deliveryFrom } from './brevo'

const MESSAGE = {
  to: 'ada@gmail.com',
  subject: 'Receipt for order ND-001040',
  html: '<p>hi</p>',
  text: 'hi',
  tags: ['transactional', 'order_receipt'],
}

describe('Brevo', () => {
  it('sends from the no-reply subdomain, replies to the support inbox, with both bodies', async () => {
    const request = vi.fn(async () => ({
      status: 201,
      body: { messageId: '<m1@smtp-relay.mailin.fr>' },
    }))
    const brevo = createBrevo({ apiKey: 'xkeysib-test-key-000000', request })

    expect(await brevo.send(MESSAGE)).toEqual({ ok: true, messageId: '<m1@smtp-relay.mailin.fr>' })
    expect(request).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': 'xkeysib-test-key-000000' },
      timeoutMs: 15_000,
      body: {
        sender: { name: 'MyDomainsHub', email: 'no-reply@notify.mydomainshub.com' },
        replyTo: { name: 'MyDomainsHub', email: 'hello@mydomainshub.com' },
        to: [{ email: 'ada@gmail.com' }],
        subject: MESSAGE.subject,
        htmlContent: '<p>hi</p>',
        textContent: 'hi',
        tags: MESSAGE.tags,
      },
    })
  })

  it('treats a refused message as permanent, and everything else as worth another try', async () => {
    const refuse = (status: number, body: unknown) =>
      createBrevo({ apiKey: 'xkeysib-test-key-000000', request: async () => ({ status, body }) })
    expect(
      await refuse(400, { code: 'invalid_parameter', message: 'email ada@x is not valid' }).send(
        MESSAGE,
      ),
    ).toEqual({
      ok: false,
      permanent: true,
      error: 'HTTP 400 invalid_parameter',
    })
    expect(await refuse(401, { code: 'unauthorized' }).send(MESSAGE)).toMatchObject({
      ok: false,
      permanent: false,
    })
    expect(await refuse(503, null).send(MESSAGE)).toEqual({
      ok: false,
      permanent: false,
      error: 'HTTP 503',
    })
    expect(await refuse(201, {}).send(MESSAGE)).toEqual({ ok: true, messageId: null })
  })

  it('never puts the address or Brevo’s message into the error', async () => {
    const brevo = createBrevo({
      apiKey: 'xkeysib-test-key-000000',
      request: async () => ({
        status: 400,
        body: { code: 'invalid_parameter', message: 'ada@gmail.com is blocked' },
      }),
    })
    const outcome = await brevo.send(MESSAGE)
    expect(JSON.stringify(outcome)).not.toContain('ada@gmail.com')
  })

  it('may retry when Brevo did not answer — a duplicate beats a lost notice', async () => {
    const silent = createBrevo({
      apiKey: 'xkeysib-test-key-000000',
      request: async () => {
        throw new NoAnswer('timeout')
      },
    })
    expect(await silent.send(MESSAGE)).toEqual({
      ok: false,
      permanent: false,
      error: 'no answer from Brevo',
    })
    const unreachable = createBrevo({
      apiKey: 'xkeysib-test-key-000000',
      request: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect(await unreachable.send(MESSAGE)).toMatchObject({
      ok: false,
      error: 'could not reach Brevo',
    })
  })

  it('reads one message’s events back by its id', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { events: [{ event: 'requests' }, { event: 'delivered' }, { event: 'opened' }] },
    }))
    const brevo = createBrevo({ apiKey: 'xkeysib-test-key-000000', request })
    expect(await brevo.delivery('<m1@smtp-relay.mailin.fr>')).toBe('delivered')
    const [url] = request.mock.calls[0] as unknown as [string]
    expect(new URL(url).searchParams.get('messageId')).toBe('<m1@smtp-relay.mailin.fr>')
    expect(new URL(url).pathname).toBe('/v3/smtp/statistics/events')
  })

  it('fails a delivery check Brevo would not answer, so it is tried again later', async () => {
    const brevo = createBrevo({
      apiKey: 'xkeysib-test-key-000000',
      request: async () => ({ status: 429, body: null }),
    })
    await expect(brevo.delivery('m')).rejects.toThrow('HTTP 429')
    const empty = createBrevo({
      apiKey: 'xkeysib-test-key-000000',
      request: async () => ({ status: 200, body: null }),
    })
    expect(await empty.delivery('m')).toBeNull()
  })
})

describe('deliveryFrom', () => {
  it('counts a hard bounce over a delivery, and a soft one as still trying', () => {
    expect(deliveryFrom(['requests', 'delivered', 'hardBounces'])).toBe('bounced')
    expect(deliveryFrom(['blocked'])).toBe('bounced')
    expect(deliveryFrom(['requests', 'softBounces'])).toBe('deferred')
    expect(deliveryFrom(['requests', 'softBounces', 'delivered'])).toBe('delivered')
    expect(deliveryFrom(['requests'])).toBeNull()
  })
})
