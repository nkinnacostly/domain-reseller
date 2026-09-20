import pino from 'pino'
import { env } from '@/lib/env'

/**
 * Structured logging. Never log PII, auth codes, API keys or full contact records
 * (PRD SEC-13) — log identifiers and let the database hold the detail.
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
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
})
