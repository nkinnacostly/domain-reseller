import pino from 'pino'
import { env } from '@/lib/env'

/**
 * Structured logging (N13, MAIL-SPEC MR4 and §11): ids and counts only —
 * never an address, a subject, a body or a key. The redactions are a net
 * under that rule, not a licence to log whole objects: log identifiers and
 * let the database hold the detail.
 *
 * No pretty transport: it is not resolvable inside Next's server bundle, and
 * JSON is what production wants anyway.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'authorization',
      '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'apiKey',
      '*.apiKey',
      'key',
      '*.key',
      'password',
      '*.password',
      'from',
      '*.from',
      'to',
      '*.to',
      'cc',
      '*.cc',
      'bcc',
      '*.bcc',
      'reply_to',
      '*.reply_to',
      'subject',
      '*.subject',
      'html',
      '*.html',
      'text',
      '*.text',
      'email',
      '*.email',
    ],
    censor: '[redacted]',
  },
})
