import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8787),
  GATEWAY_SHARED_SECRET: z.string().min(16),

  // DomainNameAPI — these live HERE and nowhere else (PRD SEC-5).
  DNA_RESELLER_ID: z.string().min(1),
  DNA_API_KEY: z.string().min(1),
  DNA_ENV: z.enum(['ote', 'production']).default('ote'),

  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
})

export const env = schema.parse(process.env)
