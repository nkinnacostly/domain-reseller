import { Buildings, CloudArrowUp, Globe } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { SUB_PROCESSORS } from '@/features/legal/lib/sub-processors'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Sub-processors',
  description:
    'The companies whose services MyDomainsHub Mail uses to send your email — Amazon SES, Supabase, Vercel, Fly.io, Flutterwave and Cloudflare — what each receives, and where.',
  path: '/legal/sub-processors',
})

/** Sub-processors (MAIL-SPEC §10). A draft until the owner's lawyer has reviewed it. */
export default function SubProcessorsPage() {
  return (
    <LegalPage
      path="/legal/sub-processors"
      title="Sub-processors"
      icons={[CloudArrowUp, Buildings, Globe]}
      intro={
        <p>
          The companies whose services we use to run Mail, what each does, what it receives and
          where. They process your recipients’ data only as our{' '}
          <Link href="/legal/dpa">Data Processing Agreement</Link> allows.
        </p>
      }
    >
      <LegalSection id="list" title="Who they are">
        {/* Phones get one card per company; a four-column table would need a
            min-width past 320px (S6). */}
        <ul className="list-none! space-y-4! pl-0! md:hidden">
          {SUB_PROCESSORS.map((processor) => (
            <li key={processor.name} className="rounded-3xl border border-border p-5">
              <h3 className="font-semibold">{processor.name}</h3>
              <dl className="mt-2 space-y-2 text-sm/6">
                <div>
                  <dt className="text-muted-foreground">What it does for Mail</dt>
                  <dd>{processor.purpose}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">What it receives</dt>
                  <dd>{processor.data}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Where</dt>
                  <dd>{processor.location}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
        {/* Its own scroll box (S5), `relative` so nothing escapes the clip;
            focusable so a keyboard can scroll it. */}
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
          tabIndex={0}
          aria-label="Sub-processors"
          className="relative mt-4 hidden overflow-x-auto rounded-3xl border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:block"
        >
          <table className="w-full border-collapse text-left text-sm/6">
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Sub-processor
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  What it does for Mail
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  What it receives
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Where
                </th>
              </tr>
            </thead>
            <tbody>
              {SUB_PROCESSORS.map((processor) => (
                <tr key={processor.name} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 font-semibold">
                    {processor.name}
                  </th>
                  <td className="px-4 py-3">{processor.purpose}</td>
                  <td className="px-4 py-3">{processor.data}</td>
                  <td className="px-4 py-3">{processor.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this list">
        <p>
          Before we add or replace a sub-processor that receives your recipients’ data, we will
          update this page and email account owners, so you can object. Questions: <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
