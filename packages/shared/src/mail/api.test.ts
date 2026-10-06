import { describe, expect, it } from 'vitest'
import {
  addressKey,
  batchSchema,
  canonicalJson,
  EMAIL_LIMITS,
  emailIdSchema,
  formatMailbox,
  idempotencyKeySchema,
  isAllowedHeader,
  isBlockedAttachment,
  parseMailbox,
  requestHash,
  sendEmailSchema,
  toEnqueueInput,
} from './api'

const EMAIL = {
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
}

const issues = (input: unknown) => {
  const parsed = sendEmailSchema.safeParse(input)
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('mailboxes', () => {
  it('reads a bare address and "Name <address>", lower-casing only the domain', () => {
    expect(parseMailbox('Ada@Example.COM')).toEqual({ name: null, address: 'Ada@example.com' })
    expect(parseMailbox('  Acme Receipts <r@Acme.example> ')).toEqual({
      name: 'Acme Receipts',
      address: 'r@acme.example',
    })
    expect(parseMailbox('"Acme, Ltd" <r@acme.example>')).toEqual({
      name: 'Acme, Ltd',
      address: 'r@acme.example',
    })
    expect(parseMailbox('<r@acme.example>')).toEqual({ name: null, address: 'r@acme.example' })
  })

  it('refuses what is not one address on one line', () => {
    for (const bad of [
      '',
      'ada',
      'ada@',
      'a b@example.com',
      'Ada <ada@example.com',
      'x\r\nBcc: y@example.com <a@b.co>',
      'Bad <name> <a@b.co>',
      `${'a'.repeat(400)}@example.com`,
    ]) {
      expect(parseMailbox(bad)).toBeNull()
    }
  })

  it('writes names plainly when it can and quoted when it must', () => {
    expect(formatMailbox({ name: null, address: 'a@b.co' })).toBe('a@b.co')
    expect(formatMailbox({ name: 'Acme', address: 'a@b.co' })).toBe('Acme <a@b.co>')
    expect(formatMailbox({ name: 'Acme, Ltd', address: 'a@b.co' })).toBe('"Acme, Ltd" <a@b.co>')
    expect(formatMailbox({ name: 'Say "hi"', address: 'a@b.co' })).toBe('"Say \\"hi\\"" <a@b.co>')
    expect(addressKey('Ada <Ada@Example.com>')).toBe('ada@example.com')
    expect(addressKey('not an address')).toBe('not an address')
  })
})

describe('sendEmailSchema (§6)', () => {
  it('accepts the README’s email and normalises it', () => {
    const parsed = sendEmailSchema.parse({
      ...EMAIL,
      to: 'Ada <ADA@EXAMPLE.COM>',
      subject: '  Your receipt ',
    })
    expect(parsed.to).toEqual(['Ada <ADA@example.com>'])
    expect(parsed.subject).toBe('Your receipt')
  })

  it('needs html or text, a subject, and at least one recipient', () => {
    expect(issues({ ...EMAIL, html: undefined })).toContain('html: Give html, text or both')
    expect(issues({ ...EMAIL, subject: ' ' })).toContain('subject: A subject is required')
    expect(issues({ ...EMAIL, to: [] })).toContain('to: At least one recipient')
    expect(issues({ ...EMAIL, subject: 'one\ntwo' })).toContain('subject: The subject is one line')
  })

  it('counts recipients across to, cc and bcc — 50 at most, each once', () => {
    const many = Array.from({ length: 30 }, (_, i) => `r${i}@example.com`)
    expect(
      issues({ ...EMAIL, to: many.slice(0, 25), cc: many.slice(25), bcc: ['x@example.com'] }),
    ).toEqual([])
    expect(issues({ ...EMAIL, to: many, cc: many.map((m) => `c${m}`) })).toContain(
      'to: At most 50 recipients across to, cc and bcc',
    )
    expect(
      issues({ ...EMAIL, to: Array.from({ length: 51 }, (_, i) => `r${i}@example.com`) }).length,
    ).toBeGreaterThan(0)
    expect(issues({ ...EMAIL, cc: ['ADA@example.com'] })).toContain(
      'to: Each recipient once, across to, cc and bcc',
    )
  })

  it('refuses fields it does not act on (N9b), and bad addresses', () => {
    expect(issues({ ...EMAIL, scheduled_at: '2026-10-07T09:00:00Z' }).join()).toContain(
      'scheduled_at',
    )
    expect(issues({ ...EMAIL, from: 'nobody' })).toContain(
      'from: Not an email address, or "Name <address>"',
    )
    expect(issues({ ...EMAIL, reply_to: 'r@acme.example' })).toEqual([])
  })

  it('allows only allow-listed headers: never From, Return-Path, DKIM or X-SES-*', () => {
    for (const ok of [
      'X-Entity-Ref-ID',
      'List-Unsubscribe',
      'list-unsubscribe-post',
      'In-Reply-To',
      'References',
    ]) {
      expect(isAllowedHeader(ok)).toBe(true)
    }
    for (const bad of [
      'From',
      'Return-Path',
      'DKIM-Signature',
      'X-SES-CONFIGURATION-SET',
      'Bcc',
      'Content-Type',
      'Subject',
      'Message-ID',
      'X Bad',
      '',
    ]) {
      expect(isAllowedHeader(bad)).toBe(false)
    }
    expect(issues({ ...EMAIL, headers: { 'X-Ref': 'ok' } })).toEqual([])
    expect(issues({ ...EMAIL, headers: { 'Return-Path': 'x@evil.example' } }).join()).toContain(
      'cannot be set',
    )
    expect(issues({ ...EMAIL, headers: { 'X-Ref': 'a\r\nBcc: x@evil.example' } }).join()).toContain(
      'one line',
    )
    expect(issues({ ...EMAIL, headers: { 'X-Ref': 'a', 'x-ref': 'b' } }).join()).toContain('twice')
    const lots = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, 'v']))
    expect(issues({ ...EMAIL, headers: lots }).join()).toContain('At most 20 headers')
  })

  it('takes base64 attachments, refuses executables and paths', () => {
    const file = {
      filename: 'receipt.pdf',
      content: 'JVBERi0xLjQK',
      content_type: 'application/pdf',
    }
    expect(issues({ ...EMAIL, attachments: [file] })).toEqual([])
    expect(
      issues({ ...EMAIL, attachments: [{ ...file, filename: 'setup.EXE' }] }).join(),
    ).toContain('Executable')
    expect(
      issues({ ...EMAIL, attachments: [{ ...file, filename: '../etc/passwd' }] }).join(),
    ).toContain('without a path')
    expect(
      issues({ ...EMAIL, attachments: [{ ...file, content: 'not base64!' }] }).join(),
    ).toContain('base64')
    expect(issues({ ...EMAIL, attachments: [{ ...file, content_type: 'pdf' }] }).join()).toContain(
      'MIME type',
    )
    expect(
      issues({ ...EMAIL, attachments: [{ ...file, path: 'https://x.example/a.pdf' }] }).length,
    ).toBeGreaterThan(0)
    expect(isBlockedAttachment('archive.tar.gz')).toBe(false)
    expect(isBlockedAttachment('script.js')).toBe(true)
    expect(isBlockedAttachment('exe')).toBe(false)
    const big = 'A'.repeat(Math.ceil((EMAIL_LIMITS.maxRequestBytes * 4) / 3) + 8)
    expect(issues({ ...EMAIL, attachments: [{ ...file, content: big }] }).join()).toContain(
      'too large',
    )
  })

  it('takes tags SES allows, each name once, never our own mdm_ names', () => {
    expect(issues({ ...EMAIL, tags: [{ name: 'kind', value: 'receipt' }] })).toEqual([])
    expect(issues({ ...EMAIL, tags: [{ name: 'mdm_email', value: 'x' }] }).join()).toContain(
      'reserved',
    )
    expect(issues({ ...EMAIL, tags: [{ name: 'kind', value: 'a b' }] }).join()).toContain(
      'Letters, digits',
    )
    expect(
      issues({
        ...EMAIL,
        tags: [
          { name: 'k', value: 'a' },
          { name: 'k', value: 'b' },
        ],
      }).join(),
    ).toContain('once')
  })

  it('a batch is 1 to 100 emails', () => {
    expect(batchSchema.safeParse([EMAIL]).success).toBe(true)
    expect(batchSchema.safeParse([]).success).toBe(false)
    expect(batchSchema.safeParse(Array.from({ length: 101 }, () => EMAIL)).success).toBe(false)
  })

  it('Idempotency-Key is printable ASCII up to 256; ids are uuids', () => {
    expect(idempotencyKeySchema.safeParse('order-1042-receipt').success).toBe(true)
    expect(idempotencyKeySchema.safeParse('has space').success).toBe(false)
    expect(idempotencyKeySchema.safeParse('x'.repeat(257)).success).toBe(false)
    expect(emailIdSchema.safeParse('6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d').success).toBe(true)
    expect(emailIdSchema.safeParse('42').success).toBe(false)
  })
})

describe('what SQL receives, and the replay fingerprint', () => {
  it('fills the defaults enqueue_email expects and strips line breaks from attachments', () => {
    const input = toEnqueueInput(
      sendEmailSchema.parse({
        ...EMAIL,
        text: '',
        attachments: [{ filename: 'a.pdf', content: 'JVBE\nRi0x' }],
      }),
    )
    expect(input).toEqual({
      email: {
        from: 'Acme <receipts@acme.example>',
        to: ['ada@example.com'],
        cc: [],
        bcc: [],
        reply_to: [],
        subject: 'Your receipt',
        tags: [],
      },
      payload: {
        html: '<p>Thanks!</p>',
        text: null,
        headers: {},
        attachments: [
          { filename: 'a.pdf', content: 'JVBERi0x', content_type: 'application/octet-stream' },
        ],
      },
    })
  })

  it('hashes equal requests equally, whatever their key order', async () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: undefined })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    )
    expect(canonicalJson(undefined)).toBe('null')
    const one = toEnqueueInput(sendEmailSchema.parse(EMAIL))
    const reordered = toEnqueueInput(
      sendEmailSchema.parse({
        html: EMAIL.html,
        subject: EMAIL.subject,
        to: EMAIL.to,
        from: EMAIL.from,
      }),
    )
    const other = toEnqueueInput(sendEmailSchema.parse({ ...EMAIL, subject: 'Another' }))
    expect(await requestHash(one)).toMatch(/^[0-9a-f]{64}$/)
    expect(await requestHash(one)).toBe(await requestHash(reordered))
    expect(await requestHash(one)).not.toBe(await requestHash(other))
  })
})
