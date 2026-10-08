import { hostname } from 'node:os'
import { API_KEY_PEPPER_MIN_CHARS } from '@dr/shared/mail'
import { z } from 'zod'

/**
 * The SMTP relay's environment (MAIL-SPEC §6, "SMTP"). It holds what the v1
 * API's routes hold — the Supabase secret key, to call authenticate_key and
 * enqueue_email, and the API key pepper — and no SES key of any kind: it
 * queues, and only the mail worker sends (§4.3). CI fails a build that
 * names a sending key here.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  MAIL_API_KEY_PEPPER: z.string().min(API_KEY_PEPPER_MIN_CHARS),

  /**
   * Where the relay listens, behind Fly's TLS on 465 and 2465 (fly.smtp.toml):
   * plain SMTP on a port only Fly's proxy reaches.
   */
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(2525),
  /** The name in the greeting: the host people configure. */
  SMTP_HOSTNAME: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/)
    .default('smtp.mydomainshub.com'),
  /** Connections at once, across every client. */
  SMTP_MAX_CLIENTS: z.coerce.number().int().min(1).max(5000).default(300),
  /** Names this relay in its logs and heartbeat. */
  MAIL_SMTP_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .default(`mail-smtp:${hostname().slice(0, 80)}`),
  /** Fly's health check (/health). */
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source)
}
