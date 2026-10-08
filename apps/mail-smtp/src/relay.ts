import {
  contentProblem,
  describeIssues,
  hashApiKey,
  isApiKey,
  parseMailbox,
  requestHash,
  sendEmailSchema,
  toEnqueueInput,
} from '@dr/shared/mail'
import { SMTPServer, type SMTPServerOptions, type SMTPServerSession } from 'smtp-server'
import { readMessage, SMTP_LIMITS } from './message'
import {
  invalidReply,
  queuedText,
  REPLIES,
  refusalReply,
  replyError,
  type SmtpReply,
} from './replies'
import type { RelayStore } from './store'

/**
 * The SMTP relay (MAIL-SPEC §6, "SMTP"): mail programs that speak only SMTP
 * — WordPress, Laravel, Django, PHPMailer, Nodemailer — send through
 * MyDomainsHub Mail with an API key as the password. Each message becomes
 * the v1 API's email (message.ts) and goes the API's way: the content checks,
 * then enqueue_email — the key, the gate, the caps, suppression and the
 * sandbox in SQL — and the mail worker sends it. Nothing here can send.
 *
 * TLS is Fly's: its proxy ends TLS on 465 and 2465 with the certificate for
 * smtp.mydomainshub.com and hands this process plain SMTP on a port nothing
 * else reaches (fly.smtp.toml). So AUTH is taken without STARTTLS here, and
 * STARTTLS is never offered.
 *
 * Every message is charged to the key's rate limit, as an API request is:
 * the AUTH charges the first; each later one asks authenticate_key again,
 * which also notices a key revoked mid-connection. Logs carry ids, counts
 * and codes — never an address, a subject, a body or the key (N13).
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type RelayDeps = {
  store: RelayStore
  pepper: string
  log: Log
  hostname: string
  maxClients: number
  relayId: string
}

/** Who a session is, once AUTH passed: the key's hash (never the key) and what SQL said. */
type SessionKey = { keyHash: string; keyId: string; accountId: string; charged: boolean }

export type RelayCounts = { accepted: number; refused: number; connections: number }

const keyOf = (session: SMTPServerSession) => session.user as SessionKey | undefined

/**
 * smtp-server reads these, but its published types (@types/smtp-server)
 * have not caught up: the limit on commands before AUTH, and the session's
 * count of messages on the connection.
 */
type Options = SMTPServerOptions & {
  maxAllowedUnauthenticatedCommands: number
  hideREQUIRETLS: boolean
}
const transactionOf = (session: SMTPServerSession) =>
  (session as SMTPServerSession & { transaction?: number }).transaction ?? 1

export function createRelay(deps: RelayDeps): { server: SMTPServer; counts: () => RelayCounts } {
  const { store, pepper, log } = deps
  const counts: RelayCounts = { accepted: 0, refused: 0, connections: 0 }

  const refuse = (reply: SmtpReply, fields: object, why: string) => {
    counts.refused += 1
    log.info({ relay: deps.relayId, code: reply.code, ...fields }, why)
    return replyError(reply)
  }

  async function deliver(raw: Buffer, session: SMTPServerSession): Promise<string> {
    const key = keyOf(session)
    if (!key) throw replyError(REPLIES.authFailed)
    const ids = { keyId: key.keyId, accountId: key.accountId, bytes: raw.length }

    // Charge this message to the key, as the API charges a request; the AUTH paid for the first.
    if (key.charged) {
      const again = await store.authenticateKey(key.keyHash)
      if (!again.ok)
        throw refuse(refusalReply(again), { ...ids, refused: again.code }, 'smtp refused')
    }
    key.charged = true

    const recipients = session.envelope.rcptTo.map((rcpt) => rcpt.address)
    const read = await readMessage(raw, recipients)
    if (!read.ok) {
      const reply = {
        unreadable: REPLIES.unreadable,
        no_from: REPLIES.noFrom,
        no_to: REPLIES.noTo,
      }[read.reason]
      throw refuse(reply, { ...ids, refused: read.reason }, 'smtp refused')
    }
    const parsed = sendEmailSchema.safeParse(read.body)
    if (!parsed.success) {
      throw refuse(
        invalidReply(describeIssues(parsed.error)),
        { ...ids, refused: 'schema' },
        'smtp refused',
      )
    }
    const email = toEnqueueInput(parsed.data)
    const content = contentProblem([email])
    if (content) {
      throw refuse(
        { code: 550, text: `5.7.1 ${content.error.message}` },
        { ...ids, refused: content.rule },
        'smtp refused by content',
      )
    }
    const answer = await store.enqueueEmail({
      accountId: key.accountId,
      keyId: key.keyId,
      email,
      idempotencyKey: read.idempotencyKey,
      requestHash: read.idempotencyKey ? await requestHash(email) : null,
    })
    if (!answer.ok) {
      throw refuse(
        refusalReply(answer),
        { ...ids, refused: answer.code, scope: answer.scope },
        'smtp refused',
      )
    }
    counts.accepted += 1
    log.info(
      {
        relay: deps.relayId,
        ...ids,
        emailId: answer.id,
        status: answer.status,
        replayed: answer.replayed,
        recipients: recipients.length,
      },
      'smtp queued',
    )
    return queuedText(answer.id)
  }

  const options: Options = {
    name: deps.hostname,
    banner: 'MyDomainsHub Mail. Sign in with an API key as the password.',
    // TLS ends at Fly's proxy (see above): plain SMTP here, AUTH allowed, no STARTTLS.
    secure: false,
    allowInsecureAuth: true,
    hideSTARTTLS: true,
    disabledCommands: ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: false,
    size: SMTP_LIMITS.maxMessageBytes,
    maxClients: deps.maxClients,
    disableReverseLookup: true,
    maxAllowedUnauthenticatedCommands: 6,
    socketTimeout: 60_000,
    closeTimeout: 30_000,
    // Our own enhanced codes are in each reply's text (replies.ts).
    hideENHANCEDSTATUSCODES: true,
    hideDSN: true,
    hideREQUIRETLS: true,
    hideSMTPUTF8: true,
    logger: false,

    onConnect(_session, callback) {
      counts.connections += 1
      callback()
    },

    onClose() {
      counts.connections = Math.max(0, counts.connections - 1)
    },

    onAuth(auth, _session, callback) {
      const password = (auth.password ?? '').trim()
      if (!isApiKey(password)) {
        callback(refuse(REPLIES.authFailed, { refused: 'not_a_key' }, 'smtp auth refused'))
        return
      }
      void (async () => {
        try {
          const keyHash = await hashApiKey(password, pepper)
          const answer = await store.authenticateKey(keyHash)
          if (!answer.ok) {
            callback(refuse(refusalReply(answer), { refused: answer.code }, 'smtp auth refused'))
            return
          }
          const user: SessionKey = {
            keyHash,
            keyId: answer.key.keyId,
            accountId: answer.key.accountId,
            charged: false,
          }
          callback(null, { user })
        } catch (error) {
          log.error({ relay: deps.relayId, err: (error as Error).name }, 'smtp auth failed')
          callback(replyError(REPLIES.authUnavailable))
        }
      })()
    },

    onMailFrom(_address, session, callback) {
      if (transactionOf(session) > SMTP_LIMITS.maxMessagesPerConnection) {
        callback(replyError(REPLIES.tooManyMessages))
        return
      }
      // The envelope sender is ours to write (SES's MAIL FROM); the From header is what counts.
      callback()
    },

    onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length >= SMTP_LIMITS.maxRecipients) {
        callback(replyError(REPLIES.tooManyRecipients))
        return
      }
      if (!parseMailbox(address.address)) {
        callback(replyError(REPLIES.badRecipient))
        return
      }
      callback()
    },

    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => {
        if (!stream.sizeExceeded) chunks.push(chunk)
      })
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          callback(refuse(REPLIES.tooBig, { refused: 'too_big' }, 'smtp refused'))
          return
        }
        deliver(Buffer.concat(chunks), session).then(
          (text) => callback(null, text),
          (error: Error & { responseCode?: number }) => {
            if (error.responseCode) return callback(error)
            log.error({ relay: deps.relayId, err: error.name }, 'smtp delivery failed')
            callback(replyError(REPLIES.internal))
          },
        )
      })
    },
  }

  return { server: new SMTPServer(options), counts: () => ({ ...counts }) }
}
