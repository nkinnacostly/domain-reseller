import { EMAIL_LIMITS } from './api'

/**
 * The SMTP relay's settings and limits (MAIL-SPEC §6, "SMTP"): one place, so
 * the relay (apps/mail-smtp), the SMTP guide and the API keys page cannot
 * disagree. The ports are the ones fly.smtp.toml exposes, both implicit TLS
 * (RFC 8314); STARTTLS is not offered, since Fly's proxy holds the
 * certificate.
 */
export const SMTP_SETTINGS = {
  host: 'smtp.mydomainshub.com',
  ports: [465, 2465],
  /** What we tell people to type. The relay checks only the password: an API key. */
  username: 'mydomainshub',
} as const

export const SMTP_LIMITS = {
  /** A whole message as it arrives: under enqueue_email's 8 MB backstop on what it stores. */
  maxMessageBytes: 7 * 1024 * 1024,
  maxRecipients: EMAIL_LIMITS.maxRecipients,
  /** Emails on one connection before the client is asked to reconnect. */
  maxMessagesPerConnection: 100,
} as const
