import { createHash } from 'node:crypto'
import {
  CONTENT_ID,
  EMAIL_LIMITS,
  formatMailbox,
  idempotencyKeySchema,
  isAllowedHeader,
  type SendEmailInput,
  SMTP_LIMITS,
} from '@dr/shared/mail'
import PostalMime, { type Address, type Email } from 'postal-mime'

/**
 * One SMTP message as the v1 API's email (MAIL-SPEC §6), so everything after
 * this — Zod's sendEmailSchema, the content checks, enqueue_email and its
 * gate — is the API's own, unchanged. The rules SMTP adds:
 *
 *   recipients — the envelope (RCPT TO) says who receives it, as SMTP
 *                always has. Those in the To and Cc headers keep their
 *                place and display name; the rest are Bcc. A header address
 *                not in the envelope receives nothing.
 *   headers    — only the ones the API allows (X-*, List-*, In-Reply-To,
 *                References, Auto-Submitted), at most 20, first kept; the
 *                rest a mail program adds (Message-ID, Date, MIME-Version,
 *                Received…) are ours to write and are dropped, not refused.
 *   files      — every attachment; one with a Content-ID inside the HTML's
 *                multipart/related, or marked inline, stays inline.
 *   retries    — a client that sends the same message again after a lost
 *                answer sends the same Message-ID to the same recipients:
 *                that pair is the Idempotency-Key, so it is queued once.
 *
 * Pure but for parsing. Nothing it reads is logged (N13).
 */

export { SMTP_LIMITS }

export type ReadMessage =
  | { ok: true; body: SendEmailInput; idempotencyKey: string | null }
  | { ok: false; reason: 'unreadable' | 'no_from' | 'no_to' }

type Mailbox = { name: string; address: string }

/** Every mailbox of a header, groups opened up. */
function mailboxes(list: readonly Address[] | undefined): Mailbox[] {
  return (list ?? []).flatMap((item) => (item.group ? item.group : [item]))
}

/** A display name the API can carry: one line, no angle brackets or quotes. */
const cleanName = (name: string) =>
  name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>"\\]/g, '')
    .trim()

const asMailbox = ({ name, address }: Mailbox) =>
  formatMailbox({ name: cleanName(name) || null, address })

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/calendar': 'ics',
  'text/plain': 'txt',
  'text/csv': 'csv',
}

/** Not a control character or a quote: what a file name may keep. */
const fileNameChar = (char: string) => {
  const code = char.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f && char !== '"'
}

/** A file name the API takes: no path, no control characters, never empty. */
export function fileName(given: string | null, index: number, type: string): string {
  const base = [...((given ?? '').split(/[\\/]/).pop() ?? '')]
    .filter(fileNameChar)
    .join('')
    .trim()
    .slice(0, 255)
  return base || `attachment-${index + 1}.${EXTENSIONS[type.toLowerCase()] ?? 'bin'}`
}

/** The headers the API allows, from the message's own lines, unfolded. */
export function allowedHeaders(lines: Email['headerLines']): Record<string, string> {
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const { line } of lines) {
    if (seen.size === EMAIL_LIMITS.maxHeaders) break
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const name = line.slice(0, colon).trim()
    const value = line
      .slice(colon + 1)
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim()
    const key = name.toLowerCase()
    if (!isAllowedHeader(name) || seen.has(key)) continue
    if (value.length > EMAIL_LIMITS.maxHeaderValueChars || !/^[\x20-\x7e\t]*$/.test(value)) continue
    seen.add(key)
    headers[name] = value
  }
  return headers
}

/**
 * The Idempotency-Key: the Message-ID and the envelope's recipients, hashed
 * — so a retry is one email, but a message an MTA split across transactions
 * (each with its own recipients) is not mistaken for a retry.
 */
export function retryKey(
  messageId: string | undefined,
  recipients: readonly string[],
): string | null {
  const id = messageId?.trim().replace(/^<|>$/g, '')
  if (!id || !idempotencyKeySchema.safeParse(id).success) return null
  const sorted = [...new Set(recipients.map((one) => one.toLowerCase()))].sort()
  const digest = createHash('sha256')
    .update(`${id}\n${sorted.join('\n')}`)
    .digest('hex')
  return `smtp-${digest}`
}

export async function readMessage(
  raw: Uint8Array,
  envelopeTo: readonly string[],
): Promise<ReadMessage> {
  let email: Email
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: 'base64', maxPartCount: 200 })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  const from = mailboxes(email.from ? [email.from] : [])[0]
  if (!from?.address) return { ok: false, reason: 'no_from' }

  // The envelope decides who receives it; the headers, where each appears.
  const envelope = new Map(envelopeTo.map((address) => [address.toLowerCase(), address]))
  const placed = new Set<string>()
  const place = (list: Mailbox[]) =>
    list.flatMap((mailbox) => {
      const key = mailbox.address.toLowerCase()
      if (!envelope.has(key) || placed.has(key)) return []
      placed.add(key)
      return [asMailbox(mailbox)]
    })
  const to = place(mailboxes(email.to))
  const cc = place(mailboxes(email.cc))
  const bcc = [...envelope].flatMap(([key, address]) => (placed.has(key) ? [] : [address]))
  if (to.length === 0) return { ok: false, reason: 'no_to' }

  const replyTo = mailboxes(email.replyTo).map(asMailbox)
  const headers = allowedHeaders(email.headerLines)
  const attachments = email.attachments
    .filter((file) => typeof file.content === 'string' && file.content.length > 0)
    .map((file, index) => {
      const type = MIME_TYPE.test(file.mimeType) ? file.mimeType : 'application/octet-stream'
      const id = file.contentId?.trim().replace(/^<|>$/g, '')
      const inline =
        Boolean(id && CONTENT_ID.test(id)) &&
        (file.related === true || file.disposition === 'inline')
      return {
        filename: fileName(file.filename, index, type),
        content: file.content as string,
        content_type: type,
        ...(inline && id ? { content_id: id } : {}),
      }
    })

  const body: SendEmailInput = {
    from: asMailbox(from),
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(replyTo.length > 0 ? { reply_to: replyTo } : {}),
    subject: (email.subject ?? '').replace(/[\r\n]+/g, ' '),
    ...(email.html ? { html: email.html } : {}),
    ...(email.text ? { text: email.text } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  }
  return { ok: true, body, idempotencyKey: retryKey(email.messageId, envelopeTo) }
}
