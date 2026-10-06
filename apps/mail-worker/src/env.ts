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
  /** Names this worker in each claim; one machine runs (MR8), so the host name will do. */
  MAIL_WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .default(`mail-worker:${hostname().slice(0, 80)}`),
  /**
   * MR6: opens each endpoint's sealed signing secret (apps/mail seals with the
   * same key). Unset, the webhook loop does not start; sending is unaffected.
   */
  MAIL_WEBHOOK_SECRET_KEY: z.string().min(40).optional(),
  /** Deliveries claimed at once, and how many are in flight together. */
  MAIL_WEBHOOK_BATCH: z.coerce.number().int().min(1).max(100).default(20),
  MAIL_WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  /** How long an empty webhook queue is left before it is asked again. */
  MAIL_WEBHOOK_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  /** Fly's health check (/health). */
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source)
}
