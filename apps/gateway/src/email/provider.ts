import type { Fetch } from '@dr/shared/ses'
import type { Env } from '../env'
import { createBrevo } from './brevo'
import type { EmailProvider, Mailer } from './mailer'
import { createSesMailer } from './ses'

/**
 * Which provider sends the outbox (EMAIL_PROVIDER: `brevo`, the default, or
 * `ses`), and whether its credentials are here. Like every optional service,
 * they are asserted where used: missing ones stop the email sender — emails
 * wait in the outbox and an ops alert says so after 30 minutes — never the
 * gateway. Only variable names are ever reported, never values (N13).
 */

type Log = { error(fields: object, message: string): void }

export type EmailSetup =
  | { provider: EmailProvider; mailer: Mailer; minIntervalMs: number }
  | { provider: EmailProvider; mailer: null; missing: string[] }

type EmailEnv = Pick<
  Env,
  | 'EMAIL_PROVIDER'
  | 'BREVO_API_KEY'
  | 'AWS_SES_REGION'
  | 'AWS_SES_ACCESS_KEY_ID'
  | 'AWS_SES_SECRET_ACCESS_KEY'
  | 'AWS_SES_CONFIGURATION_SET'
  | 'SES_MAX_SEND_RATE'
>

const SES_SETTINGS = [
  'AWS_SES_REGION',
  'AWS_SES_ACCESS_KEY_ID',
  'AWS_SES_SECRET_ACCESS_KEY',
  'AWS_SES_CONFIGURATION_SET',
] as const

export function emailSetupFor(env: EmailEnv, log: Log, deps: { fetch?: Fetch } = {}): EmailSetup {
  if (env.EMAIL_PROVIDER === 'ses') {
    const region = env.AWS_SES_REGION
    const accessKeyId = env.AWS_SES_ACCESS_KEY_ID
    const secretAccessKey = env.AWS_SES_SECRET_ACCESS_KEY
    const configurationSet = env.AWS_SES_CONFIGURATION_SET
    if (!region || !accessKeyId || !secretAccessKey || !configurationSet) {
      return { provider: 'ses', mailer: null, missing: SES_SETTINGS.filter((name) => !env[name]) }
    }
    return {
      provider: 'ses',
      mailer: createSesMailer({
        region,
        accessKeyId,
        secretAccessKey,
        configurationSet,
        log,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
      // SES_MAX_SEND_RATE messages a second: 1 in the SES sandbox.
      minIntervalMs: Math.ceil(1000 / env.SES_MAX_SEND_RATE),
    }
  }
  if (!env.BREVO_API_KEY) return { provider: 'brevo', mailer: null, missing: ['BREVO_API_KEY'] }
  return { provider: 'brevo', mailer: createBrevo({ apiKey: env.BREVO_API_KEY }), minIntervalMs: 0 }
}
