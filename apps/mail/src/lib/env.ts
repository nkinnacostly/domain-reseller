import { API_KEY_PEPPER_MIN_CHARS } from '@dr/shared/mail'
import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

/** A URL on this machine only: the e2e mocks' address, never anyone else's (N12, for email). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const loopbackUrl = z.url().refine((value) => {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
    )
  } catch {
    return false
  }
}, 'A test endpoint must be on this machine (localhost, 127.0.0.1 or [::1])')

/**
 * Mail's validated environment (docs/MAIL-SPEC.md). Import this — never
 * `process.env` directly. Values come from the repo's root .env (symlinked
 * here) and, deployed, from the Mail Vercel project.
 *
 * Services the home page does not need are optional and asserted where they
 * are used (`requireApiKeyPepper`, `requireSesManagerEnv`), as in the shop:
 * a missing key stops its feature with a clear message, never the site.
 *
 * Mail's two SES keys are kept apart (§4.3): this app holds the manager key,
 * which may manage identities and tenants but is denied every send; only the
 * mail worker holds the sending key, and it never appears here.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
    /**
     * MR7: API keys are stored as sha256(pepper ‖ key). Never in the
     * database; changing it invalidates every key. `openssl rand -hex 32`.
     */
    MAIL_API_KEY_PEPPER: z.string().min(API_KEY_PEPPER_MIN_CHARS).optional(),
    MAIL_SES_REGION: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Not an AWS region name')
      .default('eu-west-2'),
    MAIL_SES_MANAGER_ACCESS_KEY_ID: z.string().min(16).optional(),
    MAIL_SES_MANAGER_SECRET_ACCESS_KEY: z.string().min(20).optional(),
    /** The SNS topic every account's configuration set publishes to (§4.2). Not a secret. */
    MAIL_SES_EVENTS_TOPIC_ARN: z
      .string()
      .regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/, 'Not an SNS topic ARN')
      .optional(),
    /**
     * TEST ONLY (MB2's e2e): a mock SES on this machine in place of
     * email.<region>.amazonaws.com, and a mock DNS-over-HTTPS resolver for
     * the domains page's live check. Loopback addresses only; production
     * refuses both (`testEndpoints`). No e2e test ever calls real SES or DNS.
     */
    MAIL_SES_ENDPOINT: loopbackUrl.optional(),
    MAIL_DOH_URL: loopbackUrl.optional(),
    /** Set by Vercel on each deployment; `production` refuses the test endpoints. */
    VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /**
     * Cloudflare Turnstile (§7.1, the shop's SEC-9), checked on our server
     * before any form that sends an email. Both keys or neither: unset,
     * nothing is drawn or checked (lib/turnstile.ts).
     */
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  },
  client: {
    NEXT_PUBLIC_MAIL_URL: z.url().default('http://localhost:3001'),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_MAIL_URL: process.env.NEXT_PUBLIC_MAIL_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  },
  // Lets `pnpm build` run in CI without a full secret set.
  skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',
  emptyStringAsUndefined: true,
})

/** MR7: the pepper every key hash needs. The API answers 500 without it, never a guess. */
export function requireApiKeyPepper(): string {
  const pepper = env.MAIL_API_KEY_PEPPER
  if (!pepper) throw new Error('API keys are not configured: set MAIL_API_KEY_PEPPER.')
  return pepper
}

/**
 * The e2e mocks' addresses, or null for the real services. Asked again here,
 * whatever validation the build skipped: an address off this machine, or
 * either one on a production deployment, is refused outright — a mock must
 * never stand in for SES where real customers are.
 */
export function testEndpoints(
  source: { MAIL_SES_ENDPOINT?: string; MAIL_DOH_URL?: string; VERCEL_ENV?: string } = env,
): { ses: string | null; doh: string | null } {
  const ses = source.MAIL_SES_ENDPOINT || null
  const doh = source.MAIL_DOH_URL || null
  if (!ses && !doh) return { ses: null, doh: null }
  if (source.VERCEL_ENV === 'production') {
    throw new Error('MAIL_SES_ENDPOINT and MAIL_DOH_URL are for tests: production refuses them.')
  }
  for (const value of [ses, doh]) {
    if (value !== null && !loopbackUrl.safeParse(value).success) {
      throw new Error('MAIL_SES_ENDPOINT and MAIL_DOH_URL must be on this machine.')
    }
  }
  return { ses, doh }
}

/** §4.3: the manager key — identities, tenants, configuration sets, reputation; never a send. */
export function requireSesManagerEnv() {
  const accessKeyId = env.MAIL_SES_MANAGER_ACCESS_KEY_ID
  const secretAccessKey = env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'SES management is not configured: set MAIL_SES_MANAGER_ACCESS_KEY_ID and MAIL_SES_MANAGER_SECRET_ACCESS_KEY.',
    )
  }
  return { region: env.MAIL_SES_REGION ?? 'eu-west-2', accessKeyId, secretAccessKey }
}
