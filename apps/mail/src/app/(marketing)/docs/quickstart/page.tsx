import { PaperPlaneTilt, Rocket, Terminal } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection } from '@/features/api/docs/docs-frame'
import { API_KEY_ENV, readBackExample, SEND_SAMPLES } from '@/features/api/docs/samples'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { responseExample } from '@/features/marketing/lib/send-example'
import { SAFETY } from '@/features/marketing/lib/site'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Quickstart',
  description:
    'Verify your domain, make an API key and send your first email with curl, Node, Python or PHP.',
  path: '/docs/quickstart',
})

/** The quickstart (MAIL-SPEC §6 "Docs"): plain HTTP in four languages, no SDK. */
export default function QuickstartPage() {
  return (
    <DocsFrame
      slug="quickstart"
      icons={[Rocket, PaperPlaneTilt, Terminal]}
      intro={<p>Four steps from a new account to your first email, with plain HTTP.</p>}
    >
      <DocsSection id="domain" title="1. Verify the domain you send from">
        <p>
          In the dashboard, under <Link href="/dashboard/domains">Domains</Link>, add the domain
          your emails come from — <code>acme.ng</code> for <code>receipts@acme.ng</code> — and add
          the DNS records it shows at your DNS host. You can send from any address at a verified
          domain.
        </p>
        <p>
          A new account starts in the sandbox: until we approve it, it sends only to its own
          members’ confirmed addresses, at most {SAFETY.sandboxDailyCap} a day. That is enough to
          try everything below with your own address.
        </p>
      </DocsSection>

      <DocsSection id="key" title="2. Make an API key">
        <p>
          Under <Link href="/dashboard/api-keys">API keys</Link>, make a key.{' '}
          <strong>Sending only</strong> is all sending needs; a <strong>full-access</strong> key can
          also read emails back. The key is shown once: keep it in your app’s secret settings, for
          example as the environment variable <code>{API_KEY_ENV}</code>, and never in code you
          commit.
        </p>
      </DocsSection>

      <DocsSection id="send" title="3. Send">
        <p>
          One <code>POST /emails</code>. The <code>Idempotency-Key</code> makes a retry safe: send
          the same request again with the same key and it is not sent twice (see{' '}
          <Link href="/docs/idempotency">Idempotency</Link>).
        </p>
        <div className="mt-5 space-y-6">
          {SEND_SAMPLES.map((sample) => (
            <div key={sample.id} data-sample={sample.id}>
              <h3 className="font-semibold">{sample.label}</h3>
              <CodeSample
                className="mt-2"
                label={`Sending with ${sample.label}`}
                code={sample.code()}
              />
            </div>
          ))}
        </div>
        <p>The answer is the email’s id, with status 200:</p>
        <CodeSample className="mt-2" label="The answer" code={responseExample()} />
        <p>
          It means the email is <strong>queued</strong>: our sender takes it from there. A refusal
          is JSON too, with a <code>name</code> and a <code>message</code> that says what to change
          — see <Link href="/docs/errors">Errors</Link>.
        </p>
      </DocsSection>

      <DocsSection id="check" title="4. See what happened">
        <p>
          The dashboard’s <Link href="/dashboard/emails">Emails</Link> log shows every email with
          its status and each event: sent, delivered, bounced and why. Your code can ask too, with a
          full-access key and the id:
        </p>
        <CodeSample className="mt-2" label="Reading an email back" code={readBackExample()} />
        <p>
          Next: the <Link href="/docs/api">API reference</Link>, the{' '}
          <Link href="/docs/limits">limits</Link>, and{' '}
          <Link href="/docs/scheduling">scheduling</Link>.
        </p>
      </DocsSection>
    </DocsFrame>
  )
}
