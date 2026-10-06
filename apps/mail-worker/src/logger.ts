import pino, { type DestinationStream } from 'pino'

/**
 * Ids, counts and codes only (N13, MAIL-SPEC MR4 and §11): never an
 * address, a subject, a body or a key. The redactions are a net under that
 * rule, not a licence to log whole emails.
 */
export const REDACTED_PATHS = [
  'authorization',
  'secretAccessKey',
  '*.secretAccessKey',
  'from',
  '*.from',
  'to',
  '*.to',
  'cc',
  '*.cc',
  'bcc',
  '*.bcc',
  'replyTo',
  '*.replyTo',
  'subject',
  '*.subject',
  'html',
  '*.html',
  'text',
  '*.text',
  'attachments',
  '*.attachments',
]

export function createLogger(level: string, destination?: DestinationStream) {
  const options = { level, redact: { paths: REDACTED_PATHS, censor: '[redacted]' } }
  return destination ? pino(options, destination) : pino(options)
}
