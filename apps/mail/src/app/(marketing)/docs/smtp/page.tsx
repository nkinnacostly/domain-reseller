import { SMTP_LIMITS, SMTP_SETTINGS } from '@dr/shared/mail'
import { EnvelopeSimple, Plugs, ShieldCheck } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import { SMTP_MESSAGE_MB, SMTP_REPLIES, SMTP_SAMPLES, SMTP_TABLE } from '@/features/api/docs/smtp'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'SMTP',
  description:
    'Send through MyDomainsHub Mail from WordPress, Laravel, Django, PHP or Node: the SMTP host, port and sign-in, what is carried, and the replies.',
  path: '/docs/smtp',
})

/**
 * SMTP (MAIL-SPEC §6, "SMTP"): the relay's settings and limits come from
 * @dr/shared/mail, the samples and replies from features/api/docs/smtp.ts.
 */
export default function SmtpPage() {
  return (
    <DocsFrame
      slug="smtp"
      icons={[EnvelopeSimple, Plugs, ShieldCheck]}
      intro={
        <p>
          A program that sends email over SMTP — WordPress, Laravel, Django, PHPMailer, Nodemailer —
          can send through us with no code change: our host, and an API key as the password.
        </p>
      }
    >
      <DocsSection id="settings" title="The settings">
        <DocsTable
          label="SMTP settings"
          head={['Setting', 'Value']}
          rows={SMTP_TABLE.map(({ setting, value }) => [setting, <code key="v">{value}</code>])}
        />
        <p>
          Make the key under API keys in the dashboard. The From address must be at a domain
          verified on the account, as for the API. New accounts start in the sandbox, sending only
          to their own team until we have approved them.
        </p>
      </DocsSection>

      <DocsSection id="samples" title="In your framework">
        <p>
          Our tests send with Nodemailer. The others are each framework’s usual SMTP settings with
          ours filled in.
        </p>
        {SMTP_SAMPLES.map((sample) => (
          <CodeSample
            key={sample.label}
            className="mt-4"
            label={sample.label}
            title={sample.label}
            code={sample.code}
          />
        ))}
        <p>
          WordPress: in a plugin such as WP Mail SMTP, choose “Other SMTP”, then enter the host, SSL
          encryption, port {SMTP_SETTINGS.ports[0]}, authentication on, and the username and
          password above.
        </p>
      </DocsSection>

      <DocsSection id="carried" title="What is carried">
        <ul>
          <li>
            <strong>Recipients</strong> are those your program names in RCPT TO, as SMTP always has.
            Those in the To and Cc headers keep their place and name; anyone else is Bcc. At least
            one must be in To, and at most {SMTP_LIMITS.maxRecipients} in all.
          </li>
          <li>
            <strong>From, Reply-To, the subject, the HTML and text</strong>, and every attachment.
            An image the HTML shows with <code>cid:</code> stays inline.
          </li>
          <li>
            <strong>Headers</strong> the API takes: <code>X-*</code> (not <code>X-SES-*</code>),{' '}
            <code>List-Unsubscribe</code>, <code>List-Unsubscribe-Post</code>, <code>List-Id</code>,{' '}
            <code>In-Reply-To</code>, <code>References</code> and <code>Auto-Submitted</code>, at
            most 20. Others your program adds, such as <code>Message-ID</code> and <code>Date</code>
            , are ours to write and are left out.
          </li>
          <li>
            <strong>Sent twice by mistake?</strong> The same <code>Message-ID</code> to the same
            recipients within 24 hours is queued once — so a program that retries after a lost
            answer does not send it twice.
          </li>
        </ul>
        <p>
          Tags and scheduling are API-only: SMTP has no place for them. See the{' '}
          <Link href="/docs/api">API reference</Link>.
        </p>
      </DocsSection>

      <DocsSection id="limits" title="Limits">
        <ul>
          <li>
            {SMTP_MESSAGE_MB} MB a message, attachments included, and{' '}
            {SMTP_LIMITS.maxMessagesPerConnection} emails a connection.
          </li>
          <li>
            Your plan’s caps, the sandbox and your suppression list apply as they do to the API, and
            each email counts against the key’s rate limit as one request does. See the{' '}
            <Link href="/docs/limits">limits</Link>.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="replies" title="The replies">
        <p>
          A <code>4xx</code> reply means try again later; a <code>5xx</code> means something must
          change first. The text says which rule refused it, in the words the API uses.
        </p>
        <DocsTable
          label="SMTP replies"
          head={['Reply', 'What it means']}
          rows={SMTP_REPLIES.map(({ code, means }) => [<code key="c">{code}</code>, means])}
        />
      </DocsSection>
    </DocsFrame>
  )
}
