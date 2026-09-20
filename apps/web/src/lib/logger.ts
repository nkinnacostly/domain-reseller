import pino from 'pino'
import { env } from '@/lib/env'

/**
 * Structured logging. Never log PII, auth codes, API keys or full contact records
 * (PRD SEC-13) — log identifiers and let the database hold the detail.
 *
 * No pretty transport: `pino-pretty` has to be resolvable at runtime, which it
 * is not inside Next's server bundle, and JSON is what we want in production
 * anyway. Next already formats dev output readably.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'apiKey',
      '*.apiKey',
      'authCode',
      '*.authCode',
      'Auth',
      '*.Auth',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
})
