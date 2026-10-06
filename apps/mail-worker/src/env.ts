import { hostname } from 'node:os'
import { z } from 'zod'

/**
 * The mail worker's environment (MAIL-SPEC §3, §4.3, §4.4). It is the only
 * process that holds the sending key (`mdm-sender`: SendEmail and
 * SendRawEmail on Mail's tenants and configuration sets, GetAccount and
 * CloudWatch reads — nothing else), so the key is required: without it the
 * worker has no job and refuses to start.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),

  MAIL_SES_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Not an AWS region name')
    .default('eu-west-2'),
  MAIL_SES_SENDER_ACCESS_KEY_ID: z.string().min(16),
  MAIL_SES_SENDER_SECRET_ACCESS_KEY: z.string().min(20),

  /**
   * MR8: Mail's share of the SES account's send rate, in recipients a second.
   * The account allows 14 for everything; the shop keeps 4 (§4.4, owner
   * 6 Oct 2026), so 10 until AWS raises it.
   */
  MAIL_MAX_SEND_RATE: z.coerce.number().positive().max(1000).default(10),
  /** Emails claimed at once: about a second's sending, so the gate is asked just before each. */
  MAIL_CLAIM_BATCH: z.coerce.number().int().min(1).max(100).default(10),
  /** How long an empty queue is left before it is asked again. */
  MAIL_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  /** How often the SES account's 24-hour quota is read (§4.4). */
  MAIL_QUOTA_CHECK_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  /** §4.4: past this share of the 24-hour quota, free and sandbox accounts wait for paid ones. */
  MAIL_QUOTA_HOLD_FREE_AT: z.coerce.number().min(0.1).max(1).default(0.8),
  /** §7.4, §7.8: how often the safety run reads CloudWatch and judges every account. */
  MAIL_SAFETY_CHECK_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  /**
   * §7.4: where apps/mail answers the ping to apply queued SES pauses (it
   * holds the manager key; this worker never does), and the secret both share.
   * Unset, pauses still stop our own gate at once and wait, alerted on.
   */
  MAIL_APP_URL: z.url().optional(),
  MAIL_SAFETY_SECRET: z.string().min(32).optional(),
  /** Names this worker in each claim; one machine runs (MR8), so the host name will do. */
  MAIL_WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .default(`mail-worker:${hostname().slice(0, 80)}`),
  /** Fly's health check (/health). */
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source)
}
