import { type Fetch, globalFetch, timeoutSignal } from './platform'
import { signRequest } from './sigv4'

/**
 * Amazon SES API v2 `SendEmail`, signed with our own SigV4 — used by the web
 * (auth emails) and the gateway (the email outbox) when EMAIL_PROVIDER=ses.
 * Server-only by construction: nothing in the storefront's client bundle
 * imports `@dr/shared/ses`, and the credentials are only ever HMAC keys.
 *
 * A send ends one of three ways, as with Brevo:
 *   - accepted: SES's MessageId, which its delivery events carry back;
 *   - refused for good (`permanent`): SES rejected this message itself;
 *   - worth another try: throttling, a paused or suspended account, bad
 *     credentials or settings, SES unwell — or no answer at all, where SES
 *     may have accepted it. Trying again then risks a duplicate email, which
 *     beats a lost notice (at-least-once, like Brevo).
 *
 * Addresses and content never reach an error string (N13): a failure is
 * described by its HTTP status and SES's error type only — SES's message
 * text can quote the recipient.
 */

export type Mailbox = { name: string; email: string }

export type SesSettings = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Its event destination publishes deliveries, bounces and complaints to SNS. */
  configurationSet: string
  from: Mailbox
  replyTo: Mailbox
  fetch?: Fetch
  now?: () => Date
  timeoutMs?: number
}

export type SesEmail = {
  to: string
  subject: string
  html: string
  text: string
  /** Our tags — `[category, kind]` — become SES message tags. */
  tags?: readonly string[]
}

/** Failures a person must fix: SES will refuse everything until then. */
export type SesAttention = 'sending_paused' | 'account_suspended' | 'credentials' | 'configuration'

/** One clear log line for each — names of settings, never their values. */
export const SES_ATTENTION: Record<SesAttention, string> = {
  sending_paused:
    'SES has paused sending for the account or the configuration set: emails wait until it is resumed',
  account_suspended: 'SES has suspended the AWS account: emails wait until AWS lifts it',
  credentials:
    'SES refused our credentials: check AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY and the key’s ses:SendEmail permission',
  configuration:
    'SES refused our settings: check AWS_SES_CONFIGURATION_SET and the verified notify.mydomainshub.com identity',
}

export type SesSendResult =
  | { ok: true; messageId: string | null }
  | {
      ok: false
      permanent: boolean
      /** null when SES did not answer. */
      status: number | null
      /** SES's error type, e.g. `MessageRejected`. */
      code: string | null
      error: string
      attention: SesAttention | null
    }

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/
const ERROR_TYPE = /^[A-Za-z]{1,60}$/

export const sesSendUrl = (region: string) =>
  `https://email.${region}.amazonaws.com/v2/email/outbound-emails`

/** The message itself was refused: sending it again cannot help. */
const PERMANENT = new Set(['MessageRejected', 'BadRequestException'])

const ATTENTION: Record<string, SesAttention> = {
  SendingPausedException: 'sending_paused',
  AccountSuspendedException: 'account_suspended',
  MailFromDomainNotVerifiedException: 'configuration',
  NotFoundException: 'configuration',
  UnrecognizedClientException: 'credentials',
  InvalidSignatureException: 'credentials',
  SignatureDoesNotMatch: 'credentials',
  IncompleteSignatureException: 'credentials',
  InvalidClientTokenId: 'credentials',
  AccessDeniedException: 'credentials',
  MissingAuthenticationTokenException: 'credentials',
}

/**
 * How a refusal is treated. Only a refusal of the message is final; the rest
 * (429 throttling, `LimitExceededException`, 5xx, an unknown type) is tried
 * again — the outbox fails an email for good after eight attempts anyway, and
 * that raises an alert.
 */
export function classifySesError(
  status: number,
  code: string | null,
): { permanent: boolean; attention: SesAttention | null } {
  const attention =
    (code && ATTENTION[code]) || (status === 401 || status === 403 ? 'credentials' : null)
  if (attention) return { permanent: false, attention }
  if (status === 429 || status >= 500) return { permanent: false, attention: null }
  return { permanent: code !== null && PERMANENT.has(code), attention: null }
}

/** SES v2 names the error in `x-amzn-ErrorType` (`Type:uri`) or the body's `__type` (`ns#Type`). */
export function sesErrorType(header: string | null, body: unknown): string | null {
  const record = (body ?? {}) as Record<string, unknown>
  const raw =
    header ??
    [record.__type, record.code, record.Code].find((value) => typeof value === 'string') ??
    null
  if (typeof raw !== 'string') return null
  const type = raw.split(':')[0]?.split('#').pop()?.trim() ?? ''
  return ERROR_TYPE.test(type) ? type : null
}

/** SES tag names and values allow letters, digits, `_` and `-` only, up to 256. */
export function sesTags(tags: readonly string[] = []): { Name: string; Value: string }[] {
  const names = ['category', 'kind']
  return tags
    .map((tag, index) => ({
      Name: names[index] ?? `tag${index + 1}`,
      Value: tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256),
    }))
    .filter((tag) => tag.Value.replace(/_/g, '') !== '')
}

/** `Name <address>`; a name with anything but letters, digits and spaces is quoted. */
export function mailbox({ name, email }: Mailbox): string {
  if (/^[A-Za-z0-9 ]+$/.test(name)) return `${name} <${email}>`
  return `"${name.replace(/[\\"]/g, (char) => `\\${char}`)}" <${email}>`
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export function createSesClient(settings: SesSettings) {
  const {
    region,
    accessKeyId,
    secretAccessKey,
    configurationSet,
    from,
    replyTo,
    fetch = globalFetch,
    now = () => new Date(),
    timeoutMs = 15_000,
  } = settings
  if (!REGION.test(region)) throw new Error('SES: the region is not an AWS region name')
  if (!CONFIGURATION_SET.test(configurationSet)) {
    throw new Error('SES: the configuration set name is not valid')
  }
  if (!accessKeyId || !secretAccessKey) throw new Error('SES: credentials are missing')
  const url = sesSendUrl(region)

  return {
    async send(email: SesEmail): Promise<SesSendResult> {
      const tags = sesTags(email.tags)
      const body = JSON.stringify({
        FromEmailAddress: mailbox(from),
        Destination: { ToAddresses: [email.to] },
        ReplyToAddresses: [mailbox(replyTo)],
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: email.html, Charset: 'UTF-8' },
              Text: { Data: email.text, Charset: 'UTF-8' },
            },
          },
        },
        ConfigurationSetName: configurationSet,
        ...(tags.length ? { EmailTags: tags } : {}),
      })
      const signed = await signRequest(
        { method: 'POST', url, headers: { 'content-type': 'application/json' }, body },
        { accessKeyId, secretAccessKey },
        { region, service: 'ses' },
        now(),
      )

      let response: Awaited<ReturnType<Fetch>>
      let text: string
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: signed.headers,
          body,
          signal: timeoutSignal(timeoutMs),
        })
        text = await response.text()
      } catch (error) {
        // No answer: SES may have accepted it. Another try risks a duplicate,
        // which is better than a lost notice.
        const name = error instanceof Error ? error.name : ''
        return {
          ok: false,
          permanent: false,
          status: null,
          code: null,
          error:
            name === 'TimeoutError' || name === 'AbortError'
              ? 'no answer from SES'
              : 'could not reach SES',
          attention: null,
        }
      }

      const parsed = parseJson(text)
      if (response.status >= 200 && response.status < 300) {
        const messageId = (parsed as { MessageId?: unknown } | null)?.MessageId
        return { ok: true, messageId: typeof messageId === 'string' ? messageId : null }
      }
      const code = sesErrorType(response.headers.get('x-amzn-errortype'), parsed)
      const { permanent, attention } = classifySesError(response.status, code)
      return {
        ok: false,
        permanent,
        status: response.status,
        code,
        error: `HTTP ${response.status}${code ? ` ${code}` : ''}`,
        attention,
      }
    },
  }
}

export type SesClient = ReturnType<typeof createSesClient>
