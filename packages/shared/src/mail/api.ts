import { z } from 'zod'
import { base64ByteLength } from '../ses/base64'
import { sha256Hex } from '../ses/sigv4'

/**
 * The v1 sending API's input (MAIL-SPEC §6): `POST /emails` and
 * `POST /emails/batch`. The shape follows the popular email APIs — `from`,
 * `to`, `subject`, `html`, `text`, `reply_to`, `cc`, `bcc`, `attachments`,
 * `headers`, `tags` — and nothing else is accepted (N9b: a field we do not
 * act on is refused, not silently ignored).
 *
 * Every limit here is checked again in SQL where it matters (enqueue_email).
 */

export const EMAIL_LIMITS = {
  /** Across to, cc and bcc, each counted once (§6). */
  maxRecipients: 50,
  maxReplyTo: 50,
  maxSubjectChars: 998,
  /** SES v2's message limit (§6). Unreachable in one request: see maxRequestBytes. */
  maxMessageBytes: 40 * 1024 * 1024,
  /**
   * What one API request may carry. Vercel refuses a function body over
   * 4.5 MB, so attachments sent inline stay under it; larger files wait for
   * attachments by URL (§6, phase 2).
   */
  maxRequestBytes: 4 * 1024 * 1024,
  maxAttachments: 20,
  maxHeaders: 20,
  maxHeaderValueChars: 998,
  maxTags: 10,
  /** `POST /emails/batch` (§6). */
  maxBatch: 100,
  maxIdempotencyKeyChars: 256,
  /**
   * How far ahead `scheduled_at` may be (§3.1). A queued body waits in the
   * database until it is sent, so the wait is short; SQL holds the line
   * (enqueue_email, reschedule_email, migration 48).
   */
  maxScheduleHours: 72,
  /** `GET /emails`: a page holds 1 to 100, 20 unless asked. */
  maxPage: 100,
  defaultPage: 20,
} as const

// ── Mailboxes ────────────────────────────────────────────────────────────────

export type Mailbox = { name: string | null; address: string }

const ADDRESS = z.email()

/** `Name <address>` or a bare address; the address lower-cased in its domain only. */
export function parseMailbox(input: string): Mailbox | null {
  const text = input.trim()
  if (text.length === 0 || text.length > 400 || /[\r\n]/.test(text)) return null
  const angled = /^(.*?)\s*<([^<>\s]+)>$/.exec(text)
  const name = angled ? (angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1') : null
  const raw = angled ? (angled[2] ?? '') : text
  if (!ADDRESS.safeParse(raw).success) return null
  const at = raw.lastIndexOf('@')
  const address = `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`
  if (name !== null && /[<>]/.test(name)) return null
  return { name: name === '' ? null : name, address }
}

/** As stored and sent: `"Name" <address>` when there is a name, else the address. */
export function formatMailbox({ name, address }: Mailbox): string {
  if (!name) return address
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name)) return `${name} <${address}>`
  return `"${name.replace(/[\\"]/g, (char) => `\\${char}`)}" <${address}>`
}

/** The lower-cased address, for suppression and sandbox checks (as SQL's address_of). */
export const addressKey = (mailbox: string): string =>
  (parseMailbox(mailbox)?.address ?? mailbox).toLowerCase()

const mailbox = z.string().transform((value, ctx) => {
  const parsed = parseMailbox(value)
  if (!parsed) {
    ctx.addIssue({ code: 'custom', message: 'Not an email address, or "Name <address>"' })
    return z.NEVER
  }
  return formatMailbox(parsed)
})

/** One address or a list of them. */
const mailboxes = (max: number) =>
  z
    .union([mailbox.transform((one) => [one]), z.array(mailbox).max(max)])
    .refine((list) => list.length <= max, `At most ${max} addresses`)

// ── Headers (§6: allow-listed; never From, Return-Path, DKIM or X-SES-*) ────

const ALLOWED_HEADERS = new Set([
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'in-reply-to',
  'references',
  'auto-submitted',
])

/** Whether a customer may set this header. `X-*` is theirs, but never `X-SES-*`. */
export function isAllowedHeader(name: string): boolean {
  if (!/^[A-Za-z0-9-]{1,76}$/.test(name)) return false
  const lower = name.toLowerCase()
  if (lower.startsWith('x-ses-')) return false
  return lower.startsWith('x-') || ALLOWED_HEADERS.has(lower)
}

const headers = z
  .record(
    z.string(),
    z
      .string()
      .max(EMAIL_LIMITS.maxHeaderValueChars)
      .regex(/^[\x20-\x7e\t]*$/, 'Header values are printable ASCII on one line'),
  )
  .superRefine((value, ctx) => {
    const names = Object.keys(value)
    for (const name of names) {
      if (!isAllowedHeader(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            'This header cannot be set. Allowed: X-* (not X-SES-*), List-Unsubscribe, List-Unsubscribe-Post, List-Id, In-Reply-To, References, Auto-Submitted',
        })
      }
    }
    if (names.length > EMAIL_LIMITS.maxHeaders) {
      ctx.addIssue({ code: 'custom', message: `At most ${EMAIL_LIMITS.maxHeaders} headers` })
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      ctx.addIssue({ code: 'custom', message: 'A header appears twice' })
    }
  })

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * SES refuses these types outright (Amazon SES developer guide, "Unsupported
 * attachment types"); refusing them at the door is cheaper and certain
 * (§7.6: no executables).
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'ade adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its js jse ' +
    'ksh lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 ' +
    'mshxml msh1xml msh2xml msi msp mst ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ' +
    'ps2 ps2xml psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ws wsc wsf wsh xnk'
  ).split(' '),
)

export function isBlockedAttachment(filename: string): boolean {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  return filename.includes('.') && BLOCKED_ATTACHMENT_EXTENSIONS.has(extension)
}

const hasControlCharacter = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

const attachment = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) => !/[\\/"]/.test(name) && !hasControlCharacter(name),
      'A file name, without a path',
    )
    .refine((name) => !isBlockedAttachment(name), 'Executable attachments are not accepted'),
  /** Base64, as the popular APIs take it. */
  content: z
    .string()
    .min(1)
    .refine((value) => /^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(value), 'content must be base64'),
  content_type: z
    .string()
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'Not a MIME type')
    .max(127)
    .optional(),
})

// ── Tags ────────────────────────────────────────────────────────────────────

/** SES's rule for tag names and values; `mdm_` names are ours (the email id, the account). */
const tagPart = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, _ and - only')

const tag = z.strictObject({
  name: tagPart.refine(
    (name) => !name.toLowerCase().startsWith('mdm_'),
    'Tag names starting mdm_ are reserved',
  ),
  value: tagPart,
})

// ── One email ───────────────────────────────────────────────────────────────

const subject = z
  .string()
  .trim()
  .min(1, 'A subject is required')
  .max(EMAIL_LIMITS.maxSubjectChars)
  .refine((value) => !/[\r\n]/.test(value), 'The subject is one line')

/**
 * An ISO 8601 date and time with its zone (`Z` or `+01:00`): a time without
 * one would mean a different moment on every server.
 */
export const timestampSchema = z.iso.datetime({ offset: true })

/**
 * When to send (§3.1): a moment at most `maxScheduleHours` ahead — SQL
 * checks the distance against its own clock. A moment already past sends
 * at once, so a retried request whose time has gone by still sends.
 */
const scheduledAt = timestampSchema.describe(
  `When to send it: an ISO 8601 date and time with its zone, at most ${EMAIL_LIMITS.maxScheduleHours} hours ahead. A time already past sends it at once. Leave it out to send now.`,
)

export const sendEmailSchema = z
  .strictObject({
    from: mailbox.describe(
      'The sender: "Name <address>" or a bare address, at a domain verified on your account.',
    ),
    to: mailboxes(EMAIL_LIMITS.maxRecipients).describe(
      'One address or a list. To, cc and bcc together hold at most 50 recipients, each once.',
    ),
    cc: mailboxes(EMAIL_LIMITS.maxRecipients).optional().describe('One address or a list.'),
    bcc: mailboxes(EMAIL_LIMITS.maxRecipients)
      .optional()
      .describe('One address or a list. Never shown in the message’s headers.'),
    reply_to: mailboxes(EMAIL_LIMITS.maxReplyTo)
      .optional()
      .describe('One address or a list, for the Reply-To header.'),
    subject: subject.describe('One line, 1 to 998 characters.'),
    html: z.string().optional().describe('The HTML body. Give html, text or both.'),
    text: z.string().optional().describe('The plain-text body. Give html, text or both.'),
    headers: headers
      .optional()
      .describe(
        'Extra headers: X-* (not X-SES-*), List-Unsubscribe, List-Unsubscribe-Post, List-Id, In-Reply-To, References and Auto-Submitted. At most 20.',
      ),
    attachments: z
      .array(attachment)
      .max(EMAIL_LIMITS.maxAttachments)
      .optional()
      .describe(
        'Up to 20 files, each base64 in `content`. The whole request stays under 4 MB. Executable file types are refused.',
      ),
    tags: z
      .array(tag)
      .max(EMAIL_LIMITS.maxTags)
      .optional()
      .describe(
        'Up to 10 name and value pairs (letters, digits, _ and -), each name once, for finding the email later.',
      ),
    scheduled_at: scheduledAt.optional(),
  })
  .superRefine((email, ctx) => {
    if (!email.html && !email.text) {
      ctx.addIssue({ code: 'custom', path: ['html'], message: 'Give html, text or both' })
    }
    const everyone = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]
    if (email.to.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'At least one recipient' })
    }
    if (everyone.length > EMAIL_LIMITS.maxRecipients) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `At most ${EMAIL_LIMITS.maxRecipients} recipients across to, cc and bcc`,
      })
    }
    if (new Set(everyone.map(addressKey)).size !== everyone.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Each recipient once, across to, cc and bcc',
      })
    }
    const names = new Set((email.tags ?? []).map((one) => one.name))
    if (names.size !== (email.tags ?? []).length) {
      ctx.addIssue({ code: 'custom', path: ['tags'], message: 'Each tag name once' })
    }
    const attached = (email.attachments ?? []).reduce(
      (sum, one) => sum + base64ByteLength(one.content),
      0,
    )
    if (attached > EMAIL_LIMITS.maxRequestBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachments are too large for one request',
      })
    }
  })

export type SendEmailInput = z.input<typeof sendEmailSchema>
export type SendEmail = z.output<typeof sendEmailSchema>

/** `POST /emails/batch`: up to 100, each validated; all or none queued (§6). */
export const batchSchema = z.array(sendEmailSchema).min(1).max(EMAIL_LIMITS.maxBatch)

/** The `Idempotency-Key` header (§6): printable ASCII, one line. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(EMAIL_LIMITS.maxIdempotencyKeyChars)
  .regex(/^[\x21-\x7e]+$/, 'Printable ASCII without spaces')

/** An email's id in a path (`GET /emails/{id}`). */
export const emailIdSchema = z.uuid()

// ── What SQL receives (enqueue_email) ───────────────────────────────────────

export type EnqueueInput = {
  email: {
    from: string
    to: string[]
    cc: string[]
    bcc: string[]
    reply_to: string[]
    subject: string
    tags: { name: string; value: string }[]
    /** UTC, to the millisecond; absent to send now (not null, so the fingerprint of an unscheduled email stays what it was). */
    scheduled_at?: string
  }
  payload: {
    html: string | null
    text: string | null
    headers: Record<string, string>
    attachments: { filename: string; content: string; content_type: string }[]
  }
}

/** One moment, one spelling: `+01:00` and `Z` forms of the same time hash and compare equal. */
export const toUtc = (timestamp: string): string => new Date(timestamp).toISOString()

export function toEnqueueInput(email: SendEmail): EnqueueInput {
  return {
    email: {
      from: email.from,
      to: email.to,
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      reply_to: email.reply_to ?? [],
      subject: email.subject,
      tags: email.tags ?? [],
      ...(email.scheduled_at ? { scheduled_at: toUtc(email.scheduled_at) } : {}),
    },
    payload: {
      html: email.html || null,
      text: email.text || null,
      headers: email.headers ?? {},
      attachments: (email.attachments ?? []).map((one) => ({
        filename: one.filename,
        content: one.content.replace(/\s+/g, ''),
        content_type: one.content_type ?? 'application/octet-stream',
      })),
    },
  }
}

/** JSON with keys in a fixed order, so equal requests hash equal (Idempotency-Key). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The request's fingerprint for Idempotency-Key replays: sha256 of its
 * canonical JSON, hex — of one email, or of a batch in its order.
 */
export const requestHash = (input: EnqueueInput | readonly EnqueueInput[]): Promise<string> =>
  sha256Hex(canonicalJson(input))
