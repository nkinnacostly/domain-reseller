import 'server-only'

import { FLUTTERWAVE_LIVE_API_URL, isTestSecretKey } from '@dr/shared/payments'
import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

/**
 * Billing's Flutterwave settings, validated like the rest of Mail's env
 * (src/lib/env.ts) and kept with the feature that uses them. Optional: until
 * paid plans go on sale the keys are unset, the page says so, and nothing
 * else on the site depends on them (as the shop's requirePaymentEnv()).
 *
 * The account is shared with the shop and other apps; its webhook reaches us
 * through Paidly, which forwards `MDM-` references with the account's secret
 * hash as `verif-hash` (MAIL-SPEC §8).
 */
// Read on each use, not once at import: a missing key is said where it is needed,
// and the page learns the moment paid plans go on sale.
const readEnv = () =>
  createEnv({
    server: {
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      FLUTTERWAVE_SECRET_KEY: z.string().min(1).optional(),
      /** The account's "secret hash" (Flutterwave dashboard), sent on every webhook as `verif-hash`. */
      FLUTTERWAVE_WEBHOOK_HASH: z.string().min(1).optional(),
      /** For the e2e mock only; a live key is never sent anywhere but Flutterwave. */
      FLUTTERWAVE_API_URL: z.url().default(FLUTTERWAVE_LIVE_API_URL),
    },
    experimental__runtimeEnv: {},
    skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',
    emptyStringAsUndefined: true,
  })

export type BillingSettings = {
  secretKey: string
  webhookHash: string
  apiUrl: string
  /** The API's host: plan objects are recorded per host (migration 50). */
  apiHost: string
  testMode: boolean
}

/** Whether paid plans can be sold here at all. */
export function paymentsConfigured(): boolean {
  const env = readEnv()
  return Boolean(env.FLUTTERWAVE_SECRET_KEY && env.FLUTTERWAVE_WEBHOOK_HASH)
}

/**
 * The settings, asserted where a payment is made (N12): anywhere but
 * production only Flutterwave's test keys will do, and a live key goes to
 * Flutterwave's own API and nowhere else.
 */
export function requireBillingEnv(): BillingSettings {
  const billingEnv = readEnv()
  const secretKey = billingEnv.FLUTTERWAVE_SECRET_KEY
  const webhookHash = billingEnv.FLUTTERWAVE_WEBHOOK_HASH
  if (!secretKey || !webhookHash) {
    throw new Error(
      'Billing is not configured: set FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_HASH.',
    )
  }
  const testMode = isTestSecretKey(secretKey)
  if (billingEnv.NODE_ENV !== 'production' && !testMode) {
    throw new Error('Refusing a live Flutterwave key outside production. Use test keys (N12).')
  }
  const apiUrl = (billingEnv.FLUTTERWAVE_API_URL ?? FLUTTERWAVE_LIVE_API_URL).replace(/\/+$/, '')
  if (!testMode && apiUrl !== FLUTTERWAVE_LIVE_API_URL) {
    throw new Error(`A live Flutterwave key is only sent to ${FLUTTERWAVE_LIVE_API_URL}.`)
  }
  return { secretKey, webhookHash, apiUrl, apiHost: new URL(apiUrl).host, testMode }
}
