import { EMAIL_LIMITS } from '@dr/shared/mail'
import { Gauge, Ruler, Timer } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import { SAFETY } from '@/features/marketing/lib/site'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Limits',
  description:
    'What one email, one request, one API key and one plan may do with the MyDomainsHub Mail API.',
  path: '/docs/limits',
})

/**
 * §6's per-key rate: `mail.settings`' key_rate_per_second and key_burst
 * (migration 43's defaults), which no public role may read — written here
 * once, as the marketing pages' SAFETY numbers are; change them together.
 */
const KEY_RATE = { perSecond: 10, burst: 20 } as const

const MB = (bytes: number) => `${bytes / 1024 / 1024} MB`

/** Limits (MAIL-SPEC §6, §8): every number from the schemas the API validates with. */
export default function LimitsPage() {
  return (
    <DocsFrame
      slug="limits"
      icons={[Gauge, Ruler, Timer]}
      intro={<p>Every limit the API enforces, and what it answers when one is reached.</p>}
    >
      <DocsSection id="email" title="One email">
        <DocsTable
          label="Limits for one email"
          head={['What', 'Limit']}
          rows={[
            [
              'Recipients',
              `${EMAIL_LIMITS.maxRecipients} across to, cc and bcc together, each address once`,
            ],
            ['Reply-To addresses', `${EMAIL_LIMITS.maxReplyTo}`],
            ['Subject', `One line, 1 to ${EMAIL_LIMITS.maxSubjectChars} characters`],
            ['Body', 'html, text or both'],
            [
              'Attachments',
              `${EMAIL_LIMITS.maxAttachments}, base64 in the request; executable file types are refused`,
            ],
            [
              'Headers',
              `${EMAIL_LIMITS.maxHeaders}: X-* (not X-SES-*), List-Unsubscribe, List-Unsubscribe-Post, List-Id, In-Reply-To, References, Auto-Submitted`,
            ],
            ['Tags', `${EMAIL_LIMITS.maxTags} name and value pairs`],
            ['scheduled_at', `At most ${EMAIL_LIMITS.maxScheduleHours} hours ahead`],
          ]}
        />
      </DocsSection>

      <DocsSection id="content" title="Content we refuse">
        <p>
          Before an email is queued, we check three things, and refuse it with{' '}
          <code>422 validation_error</code> if any is true:
        </p>
        <ul>
          <li>
            the From name or domain imitates a bank, a payments company or a government body on our
            list;
          </li>
          <li>a link goes through a URL shortener, which hides where it leads;</li>
          <li>an attachment is a program, such as .exe, .js or .apk.</li>
        </ul>
        <p>
          The message says which, and nothing is counted against your caps. In a batch, one refused
          email refuses the batch.
        </p>
      </DocsSection>

      <DocsSection id="request" title="One request">
        <DocsTable
          label="Limits for one request"
          head={['What', 'Limit']}
          rows={[
            [
              'Size',
              `${MB(EMAIL_LIMITS.maxRequestBytes)}, attachments included; larger is refused with 413`,
            ],
            ['Emails in a batch', `1 to ${EMAIL_LIMITS.maxBatch}`],
            [
              'Emails in a page of GET /emails',
              `1 to ${EMAIL_LIMITS.maxPage}, ${EMAIL_LIMITS.defaultPage} unless asked`,
            ],
            [
              'Idempotency-Key',
              `1 to ${EMAIL_LIMITS.maxIdempotencyKeyChars} printable ASCII characters, kept 24 hours`,
            ],
          ]}
        />
      </DocsSection>

      <DocsSection id="rate" title="One key">
        <p>
          Each API key may make {KEY_RATE.perSecond} requests a second, with bursts of up to{' '}
          {KEY_RATE.burst}. Past that the answer is <code>429 rate_limited</code> with{' '}
          <code>retry-after</code>. A batch is one request.
        </p>
      </DocsSection>

      <DocsSection id="caps" title="Your plan">
        <p>
          Each plan has a cap a day and a cap a month — see <Link href="/pricing">pricing</Link>.
          Caps count recipients, not requests: an email to three people counts three. Days and
          months run on Lagos time. An email counts on the day it is to go, so a scheduled email
          counts on the day it is scheduled for, a moved one moves with it, and a canceled one is
          given back.
        </p>
        <p>
          A new account is in the sandbox: it sends only to its own members’ confirmed addresses, at
          most {SAFETY.sandboxDailyCap} a day, until we approve it. Once approved, an account starts
          at {SAFETY.warmupStartCap.toLocaleString('en-NG')} a day (or its plan’s cap, if lower)
          while it warms up.
        </p>
        <p>
          At a cap, new emails are refused with <code>429 quota_exceeded</code>, and{' '}
          <code>retry-after</code> says when the day or month starts again.
        </p>
      </DocsSection>
    </DocsFrame>
  )
}
