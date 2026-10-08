import { SMTP_LIMITS, SMTP_SETTINGS } from '@dr/shared/mail'
import { API_KEY_ENV } from './samples'

/**
 * The SMTP guide's facts (/docs/smtp), from the relay's own settings and
 * limits (@dr/shared/mail's smtp.ts) — what apps/mail-smtp does, nothing
 * more (N9b). Nodemailer is what the relay's tests send with; the other
 * samples are each framework's standard SMTP settings with ours filled in.
 */

const [PORT, ALT_PORT] = SMTP_SETTINGS.ports

export const SMTP_MESSAGE_MB = Math.floor(SMTP_LIMITS.maxMessageBytes / (1024 * 1024))

export const SMTP_TABLE: readonly { setting: string; value: string }[] = [
  { setting: 'Host', value: SMTP_SETTINGS.host },
  { setting: 'Port', value: `${PORT}, or ${ALT_PORT} where ${PORT} is blocked` },
  { setting: 'Encryption', value: 'SSL/TLS (TLS from the start). STARTTLS is not offered.' },
  { setting: 'Username', value: SMTP_SETTINGS.username },
  { setting: 'Password', value: 'An API key (mdh_live_…). A sending key is enough.' },
]

export const SMTP_SAMPLES: readonly { label: string; code: string }[] = [
  {
    label: 'Node.js (Nodemailer)',
    code: [
      "import nodemailer from 'nodemailer'",
      '',
      'const transporter = nodemailer.createTransport({',
      `  host: '${SMTP_SETTINGS.host}',`,
      `  port: ${PORT},`,
      '  secure: true,',
      `  auth: { user: '${SMTP_SETTINGS.username}', pass: process.env.${API_KEY_ENV} },`,
      '})',
      '',
      'await transporter.sendMail({',
      "  from: 'Acme <receipts@acme.ng>',",
      "  to: 'ada@example.com',",
      "  subject: 'Your receipt',",
      "  html: '<p>Thanks for your order.</p>',",
      '})',
    ].join('\n'),
  },
  {
    label: 'Laravel (.env)',
    code: [
      'MAIL_MAILER=smtp',
      'MAIL_SCHEME=smtps',
      `MAIL_HOST=${SMTP_SETTINGS.host}`,
      `MAIL_PORT=${PORT}`,
      `MAIL_USERNAME=${SMTP_SETTINGS.username}`,
      'MAIL_PASSWORD=mdh_live_…',
      'MAIL_FROM_ADDRESS=receipts@acme.ng',
      '# Laravel 10 and earlier: MAIL_ENCRYPTION=ssl instead of MAIL_SCHEME',
    ].join('\n'),
  },
  {
    label: 'Django (settings.py)',
    code: [
      `EMAIL_HOST = '${SMTP_SETTINGS.host}'`,
      `EMAIL_PORT = ${PORT}`,
      'EMAIL_USE_SSL = True',
      `EMAIL_HOST_USER = '${SMTP_SETTINGS.username}'`,
      `EMAIL_HOST_PASSWORD = os.environ['${API_KEY_ENV}']`,
      "DEFAULT_FROM_EMAIL = 'Acme <receipts@acme.ng>'",
    ].join('\n'),
  },
  {
    label: 'PHP (PHPMailer)',
    code: [
      '$mail->isSMTP();',
      `$mail->Host = '${SMTP_SETTINGS.host}';`,
      `$mail->Port = ${PORT};`,
      '$mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;',
      '$mail->SMTPAuth = true;',
      `$mail->Username = '${SMTP_SETTINGS.username}';`,
      `$mail->Password = getenv('${API_KEY_ENV}');`,
    ].join('\n'),
  },
]

/** The answers a program may get, and what each means. */
export const SMTP_REPLIES: readonly { code: string; means: string }[] = [
  {
    code: '250 2.0.0 Queued as …',
    means: 'Queued. The id is the email’s: find it in Emails, or read it with GET /emails/{id}.',
  },
  { code: '535 5.7.8', means: 'The password is not a live API key of this account.' },
  { code: '454 4.7.0', means: 'We could not check the key just now: try again in a minute.' },
  {
    code: '451 4.x.x',
    means:
      'Try again later: a busy key, today’s cap (it opens at midnight, Lagos time), or a moment of trouble on our side. A program with a queue sends again by itself.',
  },
  {
    code: '452 4.5.3',
    means: `More than ${SMTP_LIMITS.maxRecipients} recipients: send the rest as another email.`,
  },
  {
    code: '550 5.7.1',
    means:
      'Not allowed: the From domain is not verified, the account is in the sandbox or paused, this month’s cap is reached, or the content checks refused it. The text says which.',
  },
  {
    code: '550 5.6.0',
    means: 'The message itself: no From, no To, or a field the API would refuse.',
  },
  { code: '552 5.3.4', means: `Larger than ${SMTP_MESSAGE_MB} MB.` },
]
