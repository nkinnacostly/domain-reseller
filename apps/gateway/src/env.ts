import { FLUTTERWAVE_LIVE_API_URL, isTestSecretKey } from '@dr/shared'
import { z } from 'zod'

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(8787),
    GATEWAY_SHARED_SECRET: z.string().min(16),

    // DomainNameAPI — these live HERE and nowhere else (PRD SEC-5).
    DNA_RESELLER_ID: z.string().min(1),
    DNA_API_KEY: z.string().min(1),
    /** Where reads (availability, balance) go. */
    DNA_ENV: z.enum(['ote', 'production']).default('ote'),
    /** The sandbox (OTE) key. The sandbox refuses the production key. */
    DNA_API_TEST_KEY: z.string().min(1).optional(),
    /**
     * Where registrations and other writes go, and so which orders get
     * registered: `ote` takes test-payment orders to the sandbox,
     * `production` takes real ones to the live registry. `off` runs no
     * provisioning at all.
     */
    DNA_WRITE_ENV: z.enum(['off', 'ote', 'production']).default('off'),
    PROVISION_POLL_MS: z.coerce.number().int().min(500).default(5_000),
    /** How often the portfolio is compared with the registry (PRD §13.5: hourly). */
    RECONCILE_EVERY_MINUTES: z.coerce.number().int().min(5).default(60),

    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    SUPABASE_SECRET_KEY: z.string().min(1),

    /**
     * Refunds (PRD FR-R3, backlog L15). The key for the side this gateway
     * writes to: a test key with DNA_WRITE_ENV=ote, the live key with
     * production. Unset, no refunds are sent — they wait, and alert.
     */
    FLUTTERWAVE_SECRET_KEY: z.string().min(1).optional(),
    // Overridable only so tests can point at a local mock (N12).
    FLUTTERWAVE_API_URL: z.url().default('https://api.flutterwave.com/v3'),
    REFUND_POLL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** How often unpaid orders are checked with Flutterwave for a payment we missed. */
    PAYMENT_SWEEP_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

    /** Ops alerts (backlog L16), delivered by a Telegram bot. Both or neither. */
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'Not a Telegram bot token')
      .optional(),
    TELEGRAM_CHAT_ID: z
      .string()
      .regex(/^-?\d+$/, 'Not a Telegram chat id')
      .optional(),
    ALERT_EVERY_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  })
  .superRefine((value, ctx) => {
    if (value.DNA_WRITE_ENV === 'ote' && !value.DNA_API_TEST_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['DNA_API_TEST_KEY'],
        message: 'DNA_WRITE_ENV=ote needs the sandbox key',
      })
    }
    // N12: a refund goes back with the key its payment came in on. The test
    // side refunds test payments only; the live side only live ones.
    const key = value.FLUTTERWAVE_SECRET_KEY
    if (key) {
      const isTestKey = isTestSecretKey(key)
      if (value.DNA_WRITE_ENV === 'ote' && !isTestKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['FLUTTERWAVE_SECRET_KEY'],
          message: 'The sandbox side refunds test payments: use a FLWSECK_TEST- key',
        })
      }
      if (value.DNA_WRITE_ENV === 'production' && isTestKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['FLUTTERWAVE_SECRET_KEY'],
          message: 'The live side refunds real payments: use the live key',
        })
      }
      if (!isTestKey && value.NODE_ENV !== 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['FLUTTERWAVE_SECRET_KEY'],
          message: 'Refusing a live Flutterwave key outside production (N12)',
        })
      }
      // The URL is overridable for the mock; a live key goes to Flutterwave only.
      if (!isTestKey && value.FLUTTERWAVE_API_URL !== FLUTTERWAVE_LIVE_API_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['FLUTTERWAVE_API_URL'],
          message: `A live Flutterwave key is only sent to ${FLUTTERWAVE_LIVE_API_URL}`,
        })
      }
    }
    if (Boolean(value.TELEGRAM_BOT_TOKEN) !== Boolean(value.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_CHAT_ID'],
        message: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID together',
      })
    }
    // N12: real registrations spend real money. Only a production deployment
    // may make them — never a laptop, never a test run.
    if (value.DNA_WRITE_ENV === 'production' && value.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['DNA_WRITE_ENV'],
        message: 'Live registrations run only with NODE_ENV=production',
      })
    }
  })

export type Env = z.infer<typeof schema>

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return schema.parse(source)
}

export const env = parseEnv(process.env)
