import { toBase64 } from './base64'
import { buildMimeMessage, type MimeAttachment } from './mime'
import { utf8 } from './platform'
import { assertSesCredentials, type SesCredentials, sesCall } from './request'

/**
 * Mail's SendEmail (MAIL-SPEC §4.1, MR1): every send names its SES tenant
 * and its account's configuration set, so reputation stays the customer's
 * own and MyDomainsHub's receipts keep the account's. A send without both —
 * or with names that are not Mail's (`mdm-` and ten hex characters) — is
 * refused here, before anything is signed or sent. SES itself refuses an
 * identity or configuration set not associated with the tenant: a second
 * guard behind this one and behind the SQL gate (MR2).
 *
 * Simple content when the email is text and HTML only; raw MIME when it
 * carries attachments or custom headers. Bcc travels in Destination only.
 * Our tags (`mdm_email`, `mdm_account`) come back on every SES event, so an
 * event finds its email even before the message id is stored.
 */

export const MAIL_SES_RESOURCE = /^mdm-[0-9a-f]{10}$/

export type TenantEmail = {
  tenantName: string
  configurationSetName: string
  /** The email's public id and the account's short id, as SES message tags. */
  emailId: string
  accountShortId: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string[]
  subject: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  attachments?: MimeAttachment[]
  tags?: { name: string; value: string }[]
  /** Test seams for the raw message. */
  date?: Date
  boundary?: () => string
}

/**
 * How a send ended, for the worker (§4.4):
 *   throttled — SES's send rate or quota: try again shortly, not a failure;
 *   retry     — no answer, SES unwell, or our own set-up refused (credentials,
 *               a paused tenant, a missing configuration set): try again;
 *   permanent — SES refused this message: it fails.
 */
export type TenantSendResult =
  | { ok: true; messageId: string }
  | {
      ok: false
      kind: 'throttled' | 'retry' | 'permanent'
      status: number | null
      code: string | null
      error: string
    }

const THROTTLED = new Set([
  'TooManyRequestsException',
  'Throttling',
  'ThrottlingException',
  'MaxSendRateExceeded',
  'LimitExceededException',
])

/** The message or its sender's domain was refused: sending again cannot help. */
const PERMANENT = new Set([
  'MessageRejected',
  'BadRequestException',
  'MailFromDomainNotVerifiedException',
])

export function classifyTenantSend(
  status: number | null,
  code: string | null,
): 'throttled' | 'retry' | 'permanent' {
  if (status === 429 || (code !== null && THROTTLED.has(code))) return 'throttled'
  if (status !== null && status < 500 && code !== null && PERMANENT.has(code)) return 'permanent'
  return 'retry'
}

const SES_TAG = /^[A-Za-z0-9_-]{1,256}$/

export function tenantSendBody(email: TenantEmail): Record<string, unknown> {
  const raw = Boolean(email.attachments?.length) || Object.keys(email.headers ?? {}).length > 0
  const content = raw
    ? {
        Raw: {
          Data: toBase64(
            utf8(
              buildMimeMessage({
                from: email.from,
                to: email.to,
                cc: email.cc ?? [],
                replyTo: email.replyTo ?? [],
                subject: email.subject,
                html: email.html ?? null,
                text: email.text ?? null,
                headers: email.headers ?? {},
                attachments: email.attachments ?? [],
                ...(email.date ? { date: email.date } : {}),
                ...(email.boundary ? { boundary: email.boundary } : {}),
              }),
            ),
          ),
        },
      }
    : {
        Simple: {
          Subject: { Data: email.subject, Charset: 'UTF-8' },
          Body: {
            ...(email.text ? { Text: { Data: email.text, Charset: 'UTF-8' } } : {}),
            ...(email.html ? { Html: { Data: email.html, Charset: 'UTF-8' } } : {}),
          },
        },
      }
  const tags = [
    { Name: 'mdm_email', Value: email.emailId },
    { Name: 'mdm_account', Value: email.accountShortId },
    ...(email.tags ?? []).map((tag) => ({ Name: tag.name, Value: tag.value })),
  ].filter((tag) => SES_TAG.test(tag.Name) && SES_TAG.test(tag.Value))
  return {
    FromEmailAddress: email.from,
    Destination: {
      ToAddresses: email.to,
      ...(email.cc?.length ? { CcAddresses: email.cc } : {}),
      ...(email.bcc?.length ? { BccAddresses: email.bcc } : {}),
    },
    ...(email.replyTo?.length ? { ReplyToAddresses: email.replyTo } : {}),
    Content: content,
    ConfigurationSetName: email.configurationSetName,
    TenantName: email.tenantName,
    EmailTags: tags,
  }
}

export function createTenantSender(settings: SesCredentials) {
  assertSesCredentials(settings)
  return {
    async send(email: TenantEmail): Promise<TenantSendResult> {
      // MR1: never a send that would land on the account-wide reputation.
      if (
        !MAIL_SES_RESOURCE.test(email.tenantName ?? '') ||
        !MAIL_SES_RESOURCE.test(email.configurationSetName ?? '')
      ) {
        return {
          ok: false,
          kind: 'permanent',
          status: null,
          code: 'MissingTenant',
          error: 'refused: a Mail send must name its tenant and configuration set (MR1)',
        }
      }
      const answer = await sesCall(settings, {
        method: 'POST',
        path: '/outbound-emails',
        body: tenantSendBody(email),
      })
      if (answer.ok) {
        const messageId = (answer.json as { MessageId?: unknown } | null)?.MessageId
        if (typeof messageId === 'string' && messageId) return { ok: true, messageId }
        // Accepted without an id: it may have gone out. Treated as no answer.
        return {
          ok: false,
          kind: 'retry',
          status: answer.status,
          code: null,
          error: 'SES accepted without a message id',
        }
      }
      return {
        ok: false,
        kind: classifyTenantSend(answer.status, answer.code),
        status: answer.status,
        code: answer.code,
        error: answer.error,
      }
    },
  }
}

export type TenantSender = ReturnType<typeof createTenantSender>
