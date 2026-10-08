import { describe, expect, it } from 'vitest'
import { toBase64 } from '../ses/base64'
import {
  addressKey,
  batchSchema,
  canonicalJson,
  EMAIL_LIMITS,
  emailIdSchema,
  formatMailbox,
  idempotencyKeySchema,
  inlineContentType,
  isAllowedHeader,
  isBlockedAttachment,
  parseMailbox,
  requestHash,
  sendEmailSchema,
  toEnqueueInput,
  toUtc,
} from './api'
import { describeIssues } from './errors'

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

/** As the API answers it: describeIssues' sentence. */
const described = (input: unknown) => {
  const parsed = sendEmailSchema.safeParse(input)
  return parsed.success ? '' : describeIssues(parsed.error)
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
    // Open tracking is out of scope for v1 (§1): asked for, it is refused, not ignored.
    expect(issues({ ...EMAIL, track_opens: true }).join()).toContain('track_opens')
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
    // Attachments by URL are another API's: refused, saying what to send instead.
    expect(
      described({ ...EMAIL, attachments: [{ ...file, path: 'https://x.example/a.pdf' }] }),
    ).toBe(
      'attachments[0]: path: attachments by URL are not supported; send the file itself in content, as base64',
    )
    expect(isBlockedAttachment('archive.tar.gz')).toBe(false)
    expect(isBlockedAttachment('script.js')).toBe(true)
    expect(isBlockedAttachment('exe')).toBe(false)
    const big = 'A'.repeat(Math.ceil((EMAIL_LIMITS.maxRequestBytes * 4) / 3) + 8)
    expect(issues({ ...EMAIL, attachments: [{ ...file, content: big }] }).join()).toContain(
      'too large',
    )
  })

  it('takes a Node.js Buffer as JSON writes it, and turns it into base64', () => {
    const bytes = [0x25, 0x50, 0x44, 0x46, 0xff, 0x00]
    const parsed = sendEmailSchema.parse({
      ...EMAIL,
      attachments: [{ filename: 'a.pdf', content: { type: 'Buffer', data: bytes } }],
    })
    expect(parsed.attachments?.[0]?.content).toBe(toBase64(Uint8Array.from(bytes)))
    for (const content of [
      { type: 'Buffer', data: [256] },
      { type: 'Buffer', data: [1.5] },
      { type: 'Buffer', data: [] },
      { type: 'Blob', data: [1] },
      { type: 'Buffer', data: [1], extra: true },
    ]) {
      expect(issues({ ...EMAIL, attachments: [{ filename: 'a.pdf', content }] }).length).toBe(1)
    }
  })

  it('takes content_id for inline images, each once, with a type from the file name', () => {
    const logo = { filename: 'logo.PNG', content: 'iVBORw0KGgo=', content_id: 'logo@acme' }
    const input = toEnqueueInput(sendEmailSchema.parse({ ...EMAIL, attachments: [logo] }))
    expect(input.payload.attachments).toEqual([
      {
        filename: 'logo.PNG',
        content: 'iVBORw0KGgo=',
        content_type: 'image/png',
        content_id: 'logo@acme',
      },
    ])
    // A type given is kept; an unknown extension inline is octet-stream, as files are.
    expect(
      toEnqueueInput(
        sendEmailSchema.parse({
          ...EMAIL,
          attachments: [{ ...logo, filename: 'logo.bin', content_type: 'image/avif' }],
        }),
      ).payload.attachments[0]?.content_type,
    ).toBe('image/avif')
    expect(inlineContentType('logo')).toBe('application/octet-stream')
    expect(inlineContentType('a.jpeg')).toBe('image/jpeg')
    expect(issues({ ...EMAIL, attachments: [logo, { ...logo, filename: 'b.png' }] })).toEqual([
      'attachments: Each content_id once',
    ])
    for (const bad of ['', '<logo>', 'two words', 'x'.repeat(129), 'a"b']) {
      expect(issues({ ...EMAIL, attachments: [{ ...logo, content_id: bad }] }).length).toBe(1)
    }
  })

  it('names the other APIs’ fields it does not take, and what to do instead', () => {
    expect(described({ ...EMAIL, template: { id: 't' } })).toBe(
      'body: template: stored templates are not supported; send the email’s html or text',
    )
    expect(described({ ...EMAIL, topic_id: 't' })).toBe(
      'body: topic_id: topics are not supported; leave it out',
    )
    // A field nobody's API has keeps Zod's own words.
    expect(described({ ...EMAIL, colour: 'red' })).toBe('body: Unrecognized key: "colour"')
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

  it('takes scheduled_at as an ISO 8601 moment with its zone, and nothing vaguer', () => {
    expect(issues({ ...EMAIL, scheduled_at: '2026-10-07T09:00:00Z' })).toEqual([])
    expect(issues({ ...EMAIL, scheduled_at: '2026-10-07T10:00:00.250+01:00' })).toEqual([])
    for (const bad of ['2026-10-07T09:00:00', 'tomorrow', '2026-10-07', 1767225600]) {
      expect(issues({ ...EMAIL, scheduled_at: bad }).join()).toContain('scheduled_at')
    }
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

  it('passes scheduled_at in UTC, and leaves it out of an email sent now', () => {
    const later = toEnqueueInput(
      sendEmailSchema.parse({ ...EMAIL, scheduled_at: '2026-10-07T10:00:00+01:00' }),
    )
    expect(later.email.scheduled_at).toBe('2026-10-07T09:00:00.000Z')
    expect(toEnqueueInput(sendEmailSchema.parse(EMAIL)).email).not.toHaveProperty('scheduled_at')
    expect(toUtc('2026-10-07T09:00:00Z')).toBe('2026-10-07T09:00:00.000Z')
  })

  it('fingerprints a moment the same in any zone, and a batch by its order', async () => {
    const z = toEnqueueInput(
      sendEmailSchema.parse({ ...EMAIL, scheduled_at: '2026-10-07T09:00:00Z' }),
    )
    const lagos = toEnqueueInput(
      sendEmailSchema.parse({ ...EMAIL, scheduled_at: '2026-10-07T10:00:00+01:00' }),
    )
    const other = toEnqueueInput(sendEmailSchema.parse({ ...EMAIL, subject: 'Other' }))
    expect(await requestHash(z)).toBe(await requestHash(lagos))
    expect(await requestHash([z, other])).toBe(await requestHash([lagos, other]))
    expect(await requestHash([z, other])).not.toBe(await requestHash([other, z]))
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
