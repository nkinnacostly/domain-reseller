import { API_ERROR_STATUS } from '@dr/shared/mail'
import { ArrowsLeftRight, CheckCircle, Key } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import {
  RESEND_CALLS,
  RESEND_DIFFERENCES,
  RESEND_ERROR_NAMES,
  RESEND_SDK_TESTED,
  resendCodeExample,
  resendEnvExample,
} from '@/features/api/docs/resend'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Switching from Resend',
  description:
    'Move to MyDomainsHub Mail and keep Resend’s Node.js SDK: a new API key and one base URL. What works, what differs, and the error names.',
  path: '/docs/resend',
})

const codes = (names: readonly string[]) =>
  names.map((name, index) => (
    <span key={name}>
      {index > 0 ? ', ' : null}
      <code>{name}</code>
    </span>
  ))

/**
 * Switching from Resend (MAIL-SPEC §1: compatibility is claimed only where
 * a test runs that SDK against our API). The calls, differences and error
 * names are data in `features/api/docs/resend.ts`; resend-sdk.test.ts proves
 * the calls.
 */
export default function ResendPage() {
  return (
    <DocsFrame
      slug="resend"
      icons={[ArrowsLeftRight, Key, CheckCircle]}
      intro={
        <p>
          Our API takes the same requests as Resend’s, so Resend’s official Node.js SDK works
          against it unchanged. Moving is a new API key and one base URL.
        </p>
      }
    >
      <DocsSection id="before" title="Before you switch">
        <ol>
          <li>
            <strong>Add the domain you send from</strong> under Domains in the dashboard. Our three
            DKIM records (<code>…._domainkey</code>) sit beside Resend’s{' '}
            <code>resend._domainkey</code>, so both can sign while you move, and those three alone
            verify the domain with us.
          </li>
          <li>
            <strong>
              Leave Resend’s <code>send.</code> records until you have moved.
            </strong>{' '}
            Both services use <code>send.</code> your domain for bounces, each pointing at its own
            Amazon SES region. Keep Resend’s MX there until all your sending has moved, then replace
            it with ours. Until then we use Amazon SES’s own bounce address, and DKIM still passes
            DMARC. “Add to Cloudflare” leaves Resend’s records alone, and shows that MX as one for
            you to decide.
          </li>
          <li>
            <strong>Make an API key</strong> under API keys. A full-access key does everything
            below; a sending key can only send.
          </li>
          <li>
            <strong>Bring your suppression list.</strong> Under Suppressions, import the addresses
            that bounced, complained or unsubscribed with Resend — a CSV export, or one address a
            line — so this account never sends to them.
          </li>
        </ol>
        <p>
          A new account starts in the sandbox: it sends only to its own team until we have approved
          it. See the <Link href="/docs/limits">limits</Link>.
        </p>
      </DocsSection>

      <DocsSection id="switch" title="Point the SDK here">
        <p>
          Set your new key and our base URL where Resend’s SDK looks for them. With both in the
          environment, <code>new Resend()</code> needs no change at all:
        </p>
        <CodeSample className="mt-4" label="Environment" code={resendEnvExample()} />
        <p>Or give them in code, before the first request:</p>
        <CodeSample className="mt-4" label="Sending with Resend’s SDK" code={resendCodeExample()} />
        <p>
          The answer is the SDK’s own: <code>data</code> with the email’s id, or <code>error</code>{' '}
          with a <code>name</code>, a <code>message</code> and a <code>statusCode</code>.
        </p>
      </DocsSection>

      <DocsSection id="works" title="What works">
        <p>
          Our test suite runs Resend’s SDK, version {RESEND_SDK_TESTED}, against this API on every
          change. These are the calls it covers.
        </p>
        <DocsTable
          label="Resend SDK calls that work here"
          head={['Call', 'What it does here']}
          rows={RESEND_CALLS.map(({ call, here }) => [codes(call.split(', ')), here])}
        />
      </DocsSection>

      <DocsSection id="differences" title="What is different">
        <DocsTable
          label="Differences from Resend"
          head={['If you use', 'Here']}
          rows={RESEND_DIFFERENCES.map(({ what, here }) => [what, here])}
        />
      </DocsSection>

      <DocsSection id="errors" title="Error names">
        <p>
          Code that checks <code>error.statusCode</code> needs no change. Code that checks{' '}
          <code>error.name</code> should look for ours; the <Link href="/docs/errors">errors</Link>{' '}
          page explains each.
        </p>
        <DocsTable
          label="Error names, Resend’s and ours"
          head={['Resend’s SDK', 'Here', 'Status']}
          rows={RESEND_ERROR_NAMES.map(({ theirs, ours }) => [
            codes(theirs),
            codes(ours),
            codes(ours.map((name) => String(API_ERROR_STATUS[name]))),
          ])}
        />
        <p>
          <code>account_paused</code> (403) is ours alone: sending is paused on the account, and the
          dashboard says why.
        </p>
      </DocsSection>

      <DocsSection id="other-languages" title="Other languages">
        <p>
          We test Resend’s Node.js SDK only. For another language, call the HTTP API directly — the{' '}
          <Link href="/docs/quickstart">quickstart</Link> has curl, Node, Python and PHP — or write
          to <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a> and tell us which SDK you
          use.
        </p>
        <p className="text-xs text-muted-foreground">
          Resend is a trademark of its owner. MyDomainsHub is not affiliated with Resend.
        </p>
      </DocsSection>
    </DocsFrame>
  )
}
