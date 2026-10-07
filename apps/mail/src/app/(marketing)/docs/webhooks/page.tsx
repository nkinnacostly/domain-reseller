import { WEBHOOK_TIMEOUT_SECONDS, WEBHOOK_USER_AGENT } from '@dr/shared/mail'
import { Bell, PlugsConnected, ShareNetwork } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import {
  EXAMPLE_WEBHOOK_PAYLOAD,
  EXAMPLE_WEBHOOK_SECRET,
  EXAMPLE_WEBHOOK_SIGNATURE,
  exampleSignedContent,
  nodeReceiverExample,
  rawWebhookRequest,
  WEBHOOK_EVENT_DOCS,
  WEBHOOK_EVENT_ORDER,
  WEBHOOK_PORT_WORDS,
} from '@/features/api/docs/webhooks'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Webhooks',
  description:
    'Receive MyDomainsHub Mail’s events on your own server: the events, the payload, the Standard Webhooks signature and how to check it, and how retries work.',
  path: '/docs/webhooks',
})

/**
 * Webhooks (MAIL-SPEC §6, MR6): what migration 49 queues, what the mail
 * worker sends and signs (`@dr/shared/webhooks`), and what
 * `record_webhook_attempt` does with the answer. Nothing more (N9b): the
 * examples come from `features/api/docs/webhooks.ts`, which a test holds to
 * the signer.
 */
export default function WebhooksPage() {
  return (
    <DocsFrame
      slug="webhooks"
      icons={[Bell, ShareNetwork, PlugsConnected]}
      intro={
        <p>
          Events sent to your own server as they happen — an email delivered, bounced or marked as
          spam, a domain verified — each one signed, so you can tell it came from us.
        </p>
      }
    >
      <DocsSection id="endpoint" title="Set up an endpoint">
        <p>
          On the dashboard’s <Link href="/dashboard/webhooks">Webhooks</Link> page, add the address
          that should receive events and choose which events it wants. Owners, admins and developers
          can manage endpoints.
        </p>
        <ul>
          <li>
            The address must be <code>https://</code> on the public internet, on port{' '}
            {WEBHOOK_PORT_WORDS} (443 is https’s own: leave the port out). We call no other port, no
            private or internal address, and follow no redirects.
          </li>
          <li>
            Each endpoint has its own signing secret, starting <code>whsec_</code>. It is shown
            once, when the endpoint is made or its secret is rotated; keep it in your server’s
            secret settings. Rotating it stops the old secret at once.
          </li>
          <li>
            You can turn an endpoint off and on, and resend any delivery from its recent list.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="events" title="The events">
        <DocsTable
          label="Webhook events"
          head={['Event', 'Sent when', 'Also in data']}
          rows={WEBHOOK_EVENT_ORDER.map((event) => [
            <code key="event">{event}</code>,
            WEBHOOK_EVENT_DOCS[event].when,
            WEBHOOK_EVENT_DOCS[event].extra ?? '—',
          ])}
        />
        <p>
          Events are not sent in a guaranteed order, and one can arrive more than once. Use each
          event’s <code>created_at</code> to order them, and its <code>webhook-id</code> to act on
          it once.
        </p>
      </DocsSection>

      <DocsSection id="payload" title="The payload">
        <p>
          Every event is a JSON object with three fields: <code>type</code>, the event’s name;{' '}
          <code>created_at</code>, when it happened (ISO 8601, UTC); and <code>data</code>.
        </p>
        <ul>
          <li>
            For an <code>email.*</code> event, <code>data</code> holds the email’s{' '}
            <code>email_id</code> (the id <code>POST /emails</code> answered), <code>from</code>,{' '}
            <code>to</code>, <code>subject</code>, <code>tags</code> and <code>created_at</code>{' '}
            (when we accepted it), plus the fields in the table above.
          </li>
          <li>
            For a <code>domain.*</code> event, <code>data</code> holds <code>domain_id</code>,{' '}
            <code>name</code>, <code>status</code> and, for <code>domain.failed</code>, a{' '}
            <code>reason</code>.
          </li>
          <li>
            Never the email’s body or attachments: we keep a body only 72 hours, and never send it
            anywhere else.
          </li>
        </ul>
        <CodeSample
          className="mt-4"
          label="An email.delivered payload"
          code={JSON.stringify(EXAMPLE_WEBHOOK_PAYLOAD, null, 2)}
        />
      </DocsSection>

      <DocsSection id="request" title="The request">
        <p>
          Each event is one <code>POST</code> with a JSON body,{' '}
          <code>content-type: application/json</code>, <code>user-agent: {WEBHOOK_USER_AGENT}</code>
          , and the three headers of{' '}
          <a href="https://www.standardwebhooks.com" rel="noopener">
            Standard Webhooks
          </a>
          :
        </p>
        <DocsTable
          label="Signature headers"
          head={['Header', 'Holds']}
          rows={[
            [
              <code key="id">webhook-id</code>,
              'The message’s id, msg_ and 32 hex digits. The same on every retry and resend of that event to that endpoint.',
            ],
            [
              <code key="ts">webhook-timestamp</code>,
              'When this attempt was signed, in whole seconds since 1970 (Unix time).',
            ],
            [
              <code key="sig">webhook-signature</code>,
              'v1, then the base64 HMAC-SHA256 signature. The header can carry several, separated by spaces.',
            ],
          ]}
        />
        <p>On the wire, a delivery looks like this:</p>
        <CodeSample className="mt-2" label="A delivery as plain HTTP" code={rawWebhookRequest()} />
      </DocsSection>

      <DocsSection id="verify" title="Check the signature">
        <p>Check every request before you trust it:</p>
        <ol>
          <li>
            Take the secret after <code>whsec_</code> and base64-decode it: those bytes are the key.
          </li>
          <li>
            Join <code>webhook-id</code>, <code>webhook-timestamp</code> and the raw body with dots:{' '}
            <code>id.timestamp.body</code>. Use the body exactly as it arrived — JSON parsed and
            written out again will not match.
          </li>
          <li>Sign that with HMAC-SHA256 and the key, and base64 the result.</li>
          <li>
            Compare it, in constant time, with each <code>v1,</code> signature in{' '}
            <code>webhook-signature</code>. One match is enough.
          </li>
          <li>
            Refuse a <code>webhook-timestamp</code> more than five minutes from your clock, so a
            copied request cannot be replayed later.
          </li>
        </ol>
        <p>In Node, with nothing to install:</p>
        <CodeSample
          className="mt-2"
          label="Checking a delivery in Node"
          code={nodeReceiverExample()}
        />
        <p>
          To test your own check, use the request above with the secret{' '}
          <code>{EXAMPLE_WEBHOOK_SECRET}</code> (an example, not a real one). The signed content is
          the id, the timestamp and the body joined by dots, and the signature it gives is{' '}
          <code>{EXAMPLE_WEBHOOK_SIGNATURE}</code>. Your check will refuse it for its age unless you
          set your clock to its timestamp.
        </p>
        <CodeSample className="mt-2" label="The signed content" code={exampleSignedContent()} />
      </DocsSection>

      <DocsSection id="retries" title="Answers, retries and turning off">
        <ul>
          <li>
            Answer with any <strong>2xx</strong> within {WEBHOOK_TIMEOUT_SECONDS} seconds. Do slow
            work after you answer. Anything else — a 3xx, 4xx or 5xx, no answer, or a certificate we
            cannot check — counts as a failure.
          </li>
          <li>
            A failed delivery is tried again after 30 seconds, then 2, 8 and 32 minutes, then about
            2 hours, then every 6 hours, for <strong>24 hours</strong> from when the event happened.
            After that it is marked failed, and you can still resend it from the dashboard.
          </li>
          <li>
            An endpoint that has answered nothing but failures for <strong>3 days</strong>, counted
            from its first failure since its last success, is turned off at its next failure, and
            what was waiting for it is marked failed. The Webhooks page shows it as off, and the
            account log records it. Turn it back on there once it is fixed; events that happen while
            it is off are not kept for it.
          </li>
          <li>
            The dashboard shows each delivery’s attempts and the first 500 characters of your
            answer, so keep secrets out of what you answer.
          </li>
        </ul>
      </DocsSection>
    </DocsFrame>
  )
}
