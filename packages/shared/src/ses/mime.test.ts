import { describe, expect, it } from 'vitest'
import { base64ByteLength, fromBase64, toBase64, wrapBase64 } from './base64'
import { buildMimeMessage, encodeMailbox, encodeWord, mimeDate } from './mime'
import { utf8 } from './platform'

const ascii = (bytes: Uint8Array | null) => String.fromCharCode(...(bytes ?? []))
const DATE = new Date('2026-10-06T09:30:05Z')

describe('base64 (RFC 4648 test vectors)', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('%j ⇄ %j', (plain, encoded) => {
    expect(toBase64(utf8(plain))).toBe(encoded)
    expect(ascii(fromBase64(encoded))).toBe(plain)
    expect(base64ByteLength(encoded)).toBe(plain.length)
  })

  it('round-trips every byte value, ignores line breaks, refuses what is not base64', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...(fromBase64(wrapBase64(toBase64(all), 10)) ?? [])]).toEqual([...all])
    expect(fromBase64('Zm9v*')).toBeNull()
    expect(fromBase64('Zm9')).toBeNull()
    expect(fromBase64('Z=9v')).toBeNull()
  })

  it('wraps at 76 characters with CRLF', () => {
    const lines = wrapBase64('A'.repeat(200)).split('\r\n')
    expect(lines.map((line) => line.length)).toEqual([76, 76, 48])
  })
})

describe('MIME headers', () => {
  it('leaves ASCII alone and encodes anything else as UTF-8 words of at most 75 characters', () => {
    expect(encodeWord('Your receipt')).toBe('Your receipt')
    expect(encodeWord('Ẹ kú àbọ̀')).toBe(`=?UTF-8?B?${toBase64(utf8('Ẹ kú àbọ̀'))}?=`)
    const long = encodeWord('Ọ̀'.repeat(40))
    const words = long.split('\r\n ')
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75)
    expect(words.map((word) => ascii(fromBase64(word.slice(10, -2)))).join('')).toBe(
      ascii(utf8('Ọ̀'.repeat(40))),
    )
  })

  it('writes mailboxes plainly when it can, quoted or encoded when it must', () => {
    expect(encodeMailbox('ada@example.com')).toBe('ada@example.com')
    expect(encodeMailbox('Acme <receipts@acme.example>')).toBe('Acme <receipts@acme.example>')
    expect(encodeMailbox('"Acme, Ltd" <r@acme.example>')).toBe('"Acme, Ltd" <r@acme.example>')
    expect(encodeMailbox('"Say \\"hi\\"" <r@acme.example>')).toBe('"Say \\"hi\\"" <r@acme.example>')
    expect(encodeMailbox('"Adé" <ade@example.com>')).toBe(
      `=?UTF-8?B?${toBase64(utf8('Adé'))}?= <ade@example.com>`,
    )
    expect(encodeMailbox('"" <x@example.com>')).toBe('x@example.com')
  })

  it('dates in RFC 5322 form, in UTC', () => {
    expect(mimeDate(DATE)).toBe('Tue, 06 Oct 2026 09:30:05 +0000')
  })
})

describe('buildMimeMessage', () => {
  let n = 0
  const boundary = () => `b${++n}`

  it('a text-and-HTML email with a file: mixed around alternative, every line CRLF and ASCII', () => {
    n = 0
    const message = buildMimeMessage({
      from: 'Acme <receipts@acme.example>',
      to: ['ada@example.com', 'Bola <bola@example.com>'],
      cc: ['c@example.com'],
      replyTo: ['support@acme.example'],
      subject: 'Your receipt',
      text: 'Thanks!',
      html: '<p>Thanks!</p>',
      headers: { 'X-Entity-Ref-ID': 'order-1042', 'List-Unsubscribe': '<mailto:u@acme.example>' },
      attachments: [
        { filename: 'receipt.pdf', contentType: 'application/pdf', content: 'JVBERi0xLjQK' },
      ],
      date: DATE,
      boundary,
    })
    expect(message).toBe(
      [
        'From: Acme <receipts@acme.example>',
        'To: ada@example.com, Bola <bola@example.com>',
        'Cc: c@example.com',
        'Reply-To: support@acme.example',
        'Subject: Your receipt',
        'Date: Tue, 06 Oct 2026 09:30:05 +0000',
        'MIME-Version: 1.0',
        'X-Entity-Ref-ID: order-1042',
        'List-Unsubscribe: <mailto:u@acme.example>',
        'Content-Type: multipart/mixed; boundary="b2"',
        '',
        '--b2',
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        toBase64(utf8('Thanks!')),
        '--b1',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        toBase64(utf8('<p>Thanks!</p>')),
        '--b1--',
        '--b2',
        'Content-Type: application/pdf; name="receipt.pdf"',
        'Content-Disposition: attachment; filename="receipt.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '--b2--',
        '',
      ].join('\r\n'),
    )
    expect(/^[\x20-\x7e\r\n]*$/.test(message)).toBe(true)
  })

  it('one body part needs no multipart; a non-ASCII file name uses RFC 2231', () => {
    const htmlOnly = buildMimeMessage({
      from: 'a@acme.example',
      to: ['b@example.com'],
      subject: 'Kú àbọ̀',
      html: '<p>Ẹ ṣé</p>',
      headers: { 'X-Ref': 'line\r\nBcc: injected@example.com' },
      date: DATE,
    })
    expect(htmlOnly).toContain('Content-Type: text/html; charset=UTF-8\r\n')
    expect(htmlOnly).not.toContain('multipart')
    expect(htmlOnly).toContain(`Subject: =?UTF-8?B?`)
    expect(htmlOnly).toContain('X-Ref: line Bcc: injected@example.com\r\n')
    expect(htmlOnly).not.toMatch(/^Bcc:/m)

    const file = buildMimeMessage({
      from: 'a@acme.example',
      to: ['b@example.com'],
      subject: 'x',
      text: 'x',
      attachments: [{ filename: 'Ìwé "1".pdf', contentType: 'application/pdf', content: 'AAAA' }],
      date: DATE,
    })
    expect(file).toContain("filename*=UTF-8''%C3%8Cw%C3%A9%20%221%22.pdf")
    expect(file).toMatch(/boundary="mdm-[0-9a-f]{24}"/)
  })

  it('refuses a message with no body', () => {
    expect(() =>
      buildMimeMessage({ from: 'a@x.example', to: ['b@x.example'], subject: 'x' }),
    ).toThrow('text or html')
  })
})
