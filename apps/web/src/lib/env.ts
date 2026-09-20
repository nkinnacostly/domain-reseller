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

    // Not yet integrated. Optional here so an unrelated page cannot be taken
    // down by a missing payment key; the payment code asserts them at the point
    // of use via requirePaymentEnv(). Make them required once checkout ships.
    PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().min(1).optional(),
    FX_BUFFER_PCT: z.coerce.number().min(0).max(25).default(4),
    PRICE_LOCK_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Naijadomains'),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: z.string().optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
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
  const secretKey = env.PAYSTACK_SECRET_KEY
  const webhookSecret = env.PAYSTACK_WEBHOOK_SECRET

  if (!secretKey || !webhookSecret) {
    throw new Error(
      'Payments are not configured: set PAYSTACK_SECRET_KEY and PAYSTACK_WEBHOOK_SECRET.',
    )
  }

  return { secretKey, webhookSecret }
}

export function requireGatewayEnv() {
  const sharedSecret = env.GATEWAY_SHARED_SECRET

  if (!sharedSecret) {
    throw new Error('Registrar gateway is not configured: set GATEWAY_SHARED_SECRET.')
  }

  return { url: env.GATEWAY_URL, sharedSecret }
}
