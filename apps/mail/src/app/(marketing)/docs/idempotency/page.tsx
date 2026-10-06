import { ArrowsClockwise, Fingerprint, ShieldCheck } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { DocsFrame, DocsSection } from '@/features/api/docs/docs-frame'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Idempotency',
  description:
    'Send a request again without sending the email twice: the Idempotency-Key header of the MyDomainsHub Mail API.',
  path: '/docs/idempotency',
})

/** Idempotency (MAIL-SPEC §6): what enqueue_email and enqueue_batch do with the key. */
export default function IdempotencyPage() {
  return (
    <DocsFrame
      slug="idempotency"
      icons={[Fingerprint, ArrowsClockwise, ShieldCheck]}
      intro={
        <p>
          A request can time out after it arrived. With an <code>Idempotency-Key</code>, sending it
          again is safe: the email goes once.
        </p>
      }
    >
      <DocsSection id="how" title="How it works">
        <p>
          Send <code>Idempotency-Key</code> with <code>POST /emails</code> or{' '}
          <code>POST /emails/batch</code>: up to 256 printable ASCII characters, no spaces. Make it
          name the thing being sent, like <code>order-1042-receipt</code>, so a retry from anywhere
          in your code uses the same key.
        </p>
        <CodeSample
          className="mt-4"
          label="The header"
          code="Idempotency-Key: order-1042-receipt"
        />
        <ul>
          <li>
            <strong>The same key and the same request within 24 hours</strong> answers what the
            first one answered — the same id, or ids for a batch — and queues nothing more. Nothing
            more counts against your caps.
          </li>
          <li>
            <strong>The same key with a different request</strong> within 24 hours is refused with{' '}
            <code>409</code> and <code>validation_error</code>: use a new key for a new email.
          </li>
          <li>
            <strong>After 24 hours</strong> the key is free, and a request with it is a new email.
          </li>
          <li>Keys belong to your account: another account’s keys never clash with yours.</li>
          <li>
            Keys for single sends and keys for batches are kept apart: a batch’s key covers the
            whole batch, in its order.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="same" title="What counts as the same request">
        <p>
          We compare the email as we read it, not its bytes: the order of the JSON’s fields, a lone
          address or a list of one, and a time written in another zone for the same moment are all
          the same request. A changed recipient, subject, body, header, tag or{' '}
          <code>scheduled_at</code> is a different one.
        </p>
        <p>A refused request is not remembered: fix it and send it again with the same key.</p>
      </DocsSection>
    </DocsFrame>
  )
}
