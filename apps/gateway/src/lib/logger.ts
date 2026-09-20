import pino from 'pino'
import { env } from '../env'

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['password', 'apiKey', 'authCode', 'Auth', '*.Auth', 'req.headers.authorization'],
    censor: '[redacted]',
  },
})
