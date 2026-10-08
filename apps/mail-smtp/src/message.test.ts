import { sendEmailSchema } from '@dr/shared/mail'
import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'
import { describe, expect, it } from 'vitest'
import { allowedHeaders, fileName, readMessage, retryKey } from './message'

/**
 * One SMTP message as the v1 API's email: messages written by Nodemailer's
 * own composer, as a mail program writes them, read back into the shape
 * sendEmailSchema takes.
 */

function compose(options: Mail.Options): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    new MailComposer(options)
      .compile()
      .build((error, message) => (error ? reject(error) : resolve(message))),
  )
}

const BASE: Mail.Options = {
  from: '"Acme Receipts" <receipts@acme.example>',
  to: 'Ada Obi <ada@example.com>',
  subject: 'Your receipt',
  text: 'Thanks for your order.',
  html: '<p>Thanks for your order.</p>',
  messageId: '<order-1042@acme.example>',
}

async function read(options: Mail.Options, envelope: string[]) {
  return readMessage(await compose({ ...BASE, ...options }), envelope)
}

describe('readMessage', () => {
  it('reads the email the API would take: From, the bodies, the subject', async () => {
    const read1 = await read({}, ['ada@example.com'])
    expect(read1).toEqual({
      ok: true,
      body: {
        from: 'Acme Receipts <receipts@acme.example>',
        to: ['Ada Obi <ada@example.com>'],
        subject: 'Your receipt',
        html: '<p>Thanks for your order.</p>',
        text: 'Thanks for your order.',
      },
      idempotencyKey: retryKey('<order-1042@acme.example>', ['ada@example.com']),
    })
    expect(read1.ok && sendEmailSchema.safeParse(read1.body).success).toBe(true)
  })

  it('sends to the envelope: To and Cc keep their place, the rest are Bcc', async () => {
    const result = await read(
      {
        to: ['Ada Obi <ada@example.com>', 'Not Sent <header-only@example.com>'],
        cc: 'Bola <BOLA@example.com>',
      },
      ['ADA@example.com', 'bola@example.com', 'hidden@example.com'],
    )
    expect(result).toMatchObject({
      ok: true,
      body: {
        to: ['Ada Obi <ada@example.com>'],
        cc: ['Bola <BOLA@example.com>'],
        bcc: ['hidden@example.com'],
      },
    })
  })

  it('needs a From, and a To recipient among the envelope’s', async () => {
    expect(await read({ from: '' }, ['ada@example.com'])).toEqual({ ok: false, reason: 'no_from' })
    expect(await read({}, ['someone-else@example.com'])).toEqual({ ok: false, reason: 'no_to' })
  })

  it('keeps names the API can carry, and Reply-To', async () => {
    const result = await read(
      { from: '"Acme <Billing>" <billing@acme.example>', replyTo: 'Help <help@acme.example>' },
      ['ada@example.com'],
    )
    expect(result).toMatchObject({
      body: { from: 'Acme Billing <billing@acme.example>', reply_to: ['Help <help@acme.example>'] },
    })
  })

  it('carries files, an inline image by its Content-ID, and names a file without one', async () => {
    const result = await read(
      {
        html: '<p>Hi</p><img src="cid:logo@acme">',
        attachments: [
          {
            filename: 'receipt.pdf',
            content: Buffer.from('%PDF-1.4\n'),
            contentType: 'application/pdf',
          },
          {
            filename: 'logo.png',
            content: Buffer.from('png'),
            contentType: 'image/png',
            cid: 'logo@acme',
          },
          { content: Buffer.from('BEGIN:VCALENDAR'), contentType: 'text/calendar' },
        ],
      },
      ['ada@example.com'],
    )
    if (!result.ok) throw new Error('not read')
    // The inline image sits beside the HTML (multipart/related), so it is read first.
    expect(result.body.attachments).toEqual([
      {
        filename: 'logo.png',
        content: Buffer.from('png').toString('base64'),
        content_type: 'image/png',
        content_id: 'logo@acme',
      },
      {
        filename: 'receipt.pdf',
        content: Buffer.from('%PDF-1.4\n').toString('base64'),
        content_type: 'application/pdf',
      },
      expect.objectContaining({ filename: 'attachment-3.ics', content_type: 'text/calendar' }),
    ])
    expect(sendEmailSchema.safeParse(result.body).success).toBe(true)
  })

  it('passes only the headers the API allows, unfolded, at most 20', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`X-Extra-${i}`, String(i)]),
    )
    const result = await read(
      {
        headers: {
          'X-Entity-Ref-ID': 'order-1042',
          'List-Unsubscribe': '<mailto:unsubscribe@acme.example>',
          'X-SES-CONFIGURATION-SET': 'someone-elses',
          'Return-Path': '<bounce@elsewhere.example>',
          ...many,
        },
      },
      ['ada@example.com'],
    )
    if (!result.ok) throw new Error('not read')
    const headers = result.body.headers ?? {}
    expect(Object.keys(headers)).toHaveLength(20)
    expect(headers['X-Entity-Ref-ID']).toBe('order-1042')
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@acme.example>')
    for (const name of [
      'X-SES-CONFIGURATION-SET',
      'Return-Path',
      'Message-ID',
      'Date',
      'MIME-Version',
    ]) {
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(name.toLowerCase())
    }
    expect(sendEmailSchema.safeParse(result.body).success).toBe(true)
  })
})

describe('the parts', () => {
  it('allowedHeaders unfolds, drops what is not one line of ASCII, keeps the first of a name', () => {
    expect(
      allowedHeaders([
        { key: 'x-a', line: 'X-A: one\r\n two' },
        { key: 'x-a', line: 'X-A: again' },
        { key: 'x-b', line: 'X-B: caf\u00e9' },
        { key: 'x-c', line: `X-C: ${'a'.repeat(999)}` },
        { key: 'subject', line: 'Subject: hello' },
        { key: 'broken', line: 'no colon here' },
      ]),
    ).toEqual({ 'X-A': 'one two' })
  })

  it('retryKey: one Message-ID and one set of recipients, whatever their order or case', () => {
    const key = retryKey('<m1@acme.example>', ['b@example.com', 'a@example.com'])
    expect(key).toMatch(/^smtp-[0-9a-f]{64}$/)
    expect(retryKey('m1@acme.example', ['A@example.com', 'b@example.com', 'a@example.com'])).toBe(
      key,
    )
    expect(retryKey('<m1@acme.example>', ['a@example.com'])).not.toBe(key)
    expect(retryKey(undefined, ['a@example.com'])).toBeNull()
    expect(retryKey('<has space@x>', ['a@example.com'])).toBeNull()
  })

  it('fileName keeps a name without its path, and makes one when there is none', () => {
    expect(fileName('C:\\Users\\ada\\receipt.pdf', 0, 'application/pdf')).toBe('receipt.pdf')
    expect(fileName('../etc/"x".txt', 0, 'text/plain')).toBe('x.txt')
    expect(fileName(null, 1, 'image/jpeg')).toBe('attachment-2.jpg')
    expect(fileName('   ', 4, 'application/x-unknown')).toBe('attachment-5.bin')
  })
})
