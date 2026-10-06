import { API_KEY_PEPPER_MIN_CHARS } from '@dr/shared/mail'
import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

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
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  },
  client: {
    NEXT_PUBLIC_MAIL_URL: z.url().default('http://localhost:3001'),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_MAIL_URL: process.env.NEXT_PUBLIC_MAIL_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
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
