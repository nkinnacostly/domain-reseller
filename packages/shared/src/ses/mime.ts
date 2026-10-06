import { toBase64, wrapBase64 } from './base64'
import { randomBytes, utf8 } from './platform'

/**
 * A raw MIME message (RFC 5322, 2045–2047, 2231) for SES SendEmail's `Raw`
 * content: what Mail sends when an email carries attachments or custom
 * headers (MAIL-SPEC §6). Every line is ASCII and CRLF-terminated: text and
 * HTML go as base64 UTF-8, non-ASCII names and subjects as encoded words.
 * The headers given have already passed the allow-list (`isAllowedHeader`);
 * From, To, Cc, Reply-To, Subject, Date and the MIME headers are ours alone.
 * Bcc never appears: those recipients travel in SendEmail's Destination.
 */

export type MimeAttachment = { filename: string; contentType: string; content: string }

export type MimeMessage = {
  from: string
  to: string[]
  cc?: string[]
  replyTo?: string[]
  subject: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  attachments?: MimeAttachment[]
  date?: Date
  /** Test seam: boundaries are random. */
  boundary?: () => string
}

const CRLF = '\r\n'
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value)

/** RFC 2047 encoded words of at most 75 characters, split on whole characters. */
export function encodeWord(value: string): string {
  if (isAscii(value)) return value
  const words: string[] = []
  let chunk = ''
  for (const char of value) {
    // 45 bytes of UTF-8 is 60 base64 characters: inside the 75 with the wrapper.
    if (utf8(chunk + char).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${toBase64(utf8(word))}?=`).join(`${CRLF} `)
}

/** `"Display Name" <address>` with the name encoded when it is not ASCII. */
export function encodeMailbox(mailbox: string): string {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^<>\s]+)>\s*$/.exec(mailbox)
  if (!match) return mailbox.trim()
  const name = (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1').trim()
  const address = match[3] ?? ''
  if (!name) return address
  if (!isAscii(name)) return `${encodeWord(name)} <${address}>`
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name)) return `${name} <${address}>`
  return `"${name.replace(/[\\"]/g, (char) => `\\${char}`)}" <${address}>`
}

/** RFC 5322 date, always UTC: `Tue, 06 Oct 2026 10:00:00 +0000`. */
export function mimeDate(at: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${days[at.getUTCDay()]}, ${pad(at.getUTCDate())} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} +0000`
}

/** `filename="a.pdf"`, or RFC 2231's `filename*=UTF-8''…` for anything else. */
function fileParameter(key: 'name' | 'filename', filename: string): string {
  if (isAscii(filename) && !/["\\]/.test(filename)) return `${key}="${filename}"`
  const encoded = [...utf8(filename)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      return /[A-Za-z0-9!#$&+.^_`|~-]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
  return `${key}*=UTF-8''${encoded}`
}

const randomBoundary = () =>
  `mdm-${[...randomBytes(12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`

function textPart(type: 'plain' | 'html', body: string): string {
  return [
    `Content-Type: text/${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(toBase64(utf8(body))),
  ].join(CRLF)
}

function multipart(type: 'alternative' | 'mixed', boundary: string, parts: string[]): string {
  return [
    `Content-Type: multipart/${type}; boundary="${boundary}"`,
    '',
    ...parts.map((part) => `--${boundary}${CRLF}${part}`),
    `--${boundary}--`,
  ].join(CRLF)
}

export function buildMimeMessage(message: MimeMessage): string {
  const boundary = message.boundary ?? randomBoundary
  const bodies: string[] = []
  if (message.text) bodies.push(textPart('plain', message.text))
  if (message.html) bodies.push(textPart('html', message.html))
  if (bodies.length === 0) throw new Error('MIME: a message needs text or html')
  let content =
    bodies.length === 1 ? (bodies[0] as string) : multipart('alternative', boundary(), bodies)

  const attachments = message.attachments ?? []
  if (attachments.length > 0) {
    const files = attachments.map((file) =>
      [
        `Content-Type: ${file.contentType}; ${fileParameter('name', file.filename)}`,
        `Content-Disposition: attachment; ${fileParameter('filename', file.filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(file.content),
      ].join(CRLF),
    )
    content = multipart('mixed', boundary(), [content, ...files])
  }

  const head = [
    `From: ${encodeMailbox(message.from)}`,
    `To: ${message.to.map(encodeMailbox).join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.map(encodeMailbox).join(', ')}`] : []),
    ...(message.replyTo?.length
      ? [`Reply-To: ${message.replyTo.map(encodeMailbox).join(', ')}`]
      : []),
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${mimeDate(message.date ?? new Date())}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers ?? {}).map(
      ([name, value]) => `${name}: ${value.replace(/[\r\n]+/g, ' ')}`,
    ),
  ]
  return `${head.join(CRLF)}${CRLF}${content}${CRLF}`
}
