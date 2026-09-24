import { FLUTTERWAVE_LIVE_API_URL, isTestSecretKey } from '@dr/shared/payments'
import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

/**
 * Validated environment. Import this — never `process.env` directly.
 * A missing or malformed variable fails the build, not production traffic.
 *
 * NOTE: DomainNameAPI credentials deliberately do NOT appear here.
 * They belong to apps/gateway alone (PRD §6.4, SEC-5).
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
    GATEWAY_URL: z.url().default('http://localhost:8787'),
    GATEWAY_SHARED_SECRET: z.string().min(16).optional(),
    /** Pre-launch: only these accounts (comma-separated emails) may pay. Unset = open. */
    CHECKOUT_ALLOWLIST: z.string().optional(),

    // Not yet integrated. Optional here so an unrelated page cannot be taken
    // down by a missing payment key; the payment code asserts them at the point
    // of use via requirePaymentEnv(). Make them required once checkout ships.
    // Flutterwave (PRD §8.4). The webhook hash is the "secret hash" set in the
    // Flutterwave dashboard; it arrives on every webhook as `verif-hash` (SEC-7).
    FLUTTERWAVE_SECRET_KEY: z.string().min(1).optional(),
    FLUTTERWAVE_ENCRYPTION_KEY: z.string().min(1).optional(),
    FLUTTERWAVE_WEBHOOK_HASH: z.string().min(1).optional(),
    // Overridable only so e2e tests can point at a local mock (N12).
    FLUTTERWAVE_API_URL: z.url().default('https://api.flutterwave.com/v3'),
    FX_BUFFER_PCT: z.coerce.number().min(0).max(25).default(4),
    PRICE_LOCK_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    NEXT_PUBLIC_APP_NAME: z.string().min(1).default('MyDomainsHub'),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: process.env.NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
  // Lets `pnpm build` run in CI without a full secret set.
  skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',
  emptyStringAsUndefined: true,
})

/**
 * Assert the environment a feature needs, at the point it actually runs.
 *
 * Keeping these out of the module-level schema means a missing payment key
 * breaks checkout with a clear message rather than taking down the storefront.
 */
export function requirePaymentEnv() {
  const secretKey = env.FLUTTERWAVE_SECRET_KEY
  const publicKey = env.NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY
  const webhookHash = env.FLUTTERWAVE_WEBHOOK_HASH

  if (!secretKey || !publicKey || !webhookHash) {
    throw new Error(
      'Payments are not configured: set FLUTTERWAVE_SECRET_KEY, NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY and FLUTTERWAVE_WEBHOOK_HASH.',
    )
  }

  // N12 in code: anywhere but production, only test keys will do. Flutterwave
  // marks them FLWSECK_TEST- / FLWPUBK_TEST-.
  const isTestKey = isTestSecretKey
  if (env.NODE_ENV !== 'production' && (!isTestKey(secretKey) || !isTestKey(publicKey))) {
    throw new Error('Refusing live Flutterwave keys outside production. Use test keys (N12).')
  }
  // A live key goes to Flutterwave and nowhere else: FLUTTERWAVE_API_URL exists
  // for the e2e mock, and must not become a way to send the key elsewhere.
  // (Unset only where validation is skipped, when the default applies.)
  const apiUrl = env.FLUTTERWAVE_API_URL ?? FLUTTERWAVE_LIVE_API_URL
  if (!isTestKey(secretKey) && apiUrl !== FLUTTERWAVE_LIVE_API_URL) {
    throw new Error(`A live Flutterwave key is only sent to ${FLUTTERWAVE_LIVE_API_URL}.`)
  }

  return { secretKey, publicKey, webhookHash, testMode: isTestKey(secretKey) }
}

export function requireGatewayEnv() {
  const sharedSecret = env.GATEWAY_SHARED_SECRET

  if (!sharedSecret) {
    throw new Error('Registrar gateway is not configured: set GATEWAY_SHARED_SECRET.')
  }

  return { url: env.GATEWAY_URL, sharedSecret }
}
