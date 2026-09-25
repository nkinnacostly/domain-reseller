import { EMAIL_BRAND } from '@dr/shared'
import {
  createSesClient,
  type Fetch,
  SES_ATTENTION,
  type SesAttention,
  type SesSettings,
} from '@dr/shared/ses'
import type { Mailer } from './mailer'

/**
 * Amazon SES as the gateway's mailer (L1): the same From and Reply-To as
 * Brevo, tagged, in the configuration set whose event destination publishes
 * deliveries, bounces and complaints to SNS — so there is nothing to poll
 * here: those reports reach the web (`/api/email/ses-events`, migration 34).
 *
 * A refusal a person must fix — sending paused, the account suspended, bad
 * credentials or settings — is logged once, clearly, until a send succeeds;
 * every email meanwhile waits and is tried again (N13: names, never values).
 */

type Log = { error(fields: object, message: string): void }

export type SesMailerOptions = Pick<
  SesSettings,
  'region' | 'accessKeyId' | 'secretAccessKey' | 'configurationSet'
> & {
  log: Log
  fetch?: Fetch
  now?: () => Date
}

export function createSesMailer(options: SesMailerOptions): Mailer {
  const { log, fetch, now, ...credentials } = options
  const ses = createSesClient({
    ...credentials,
    from: { name: EMAIL_BRAND.name, email: EMAIL_BRAND.noReplyEmail },
    replyTo: { name: EMAIL_BRAND.name, email: EMAIL_BRAND.supportEmail },
    ...(fetch ? { fetch } : {}),
    ...(now ? { now } : {}),
  })
  const reported = new Set<SesAttention>()

  return {
    provider: 'ses',
    async send(message) {
      const result = await ses.send(message)
      if (result.ok) {
        reported.clear()
        return { ok: true, messageId: result.messageId }
      }
      if (result.attention && !reported.has(result.attention)) {
        reported.add(result.attention)
        log.error(
          { attention: result.attention, code: result.code, status: result.status },
          SES_ATTENTION[result.attention],
        )
      }
      return { ok: false, permanent: result.permanent, error: result.error }
    },
  }
}
