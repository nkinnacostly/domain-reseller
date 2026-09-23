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

    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    SUPABASE_SECRET_KEY: z.string().min(1),

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
