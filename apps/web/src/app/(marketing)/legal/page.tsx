import { ArrowRight } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage } from '@/features/legal/components/legal-page'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Legal',
  description: `The agreements and policies that apply when you register a domain with ${BUSINESS.brand}.`,
  path: '/legal',
})

export default function LegalIndexPage() {
  return (
    <LegalPage
      path="/legal"
      title="Legal"
      nav="none"
      intro={<p>The agreements and policies that apply when you register a domain with us.</p>}
    >
      {/* The reading column styles lists and links as prose; these are cards. */}
      <ul className="mt-0! grid list-none! gap-5 space-y-0! pl-0! sm:grid-cols-2">
        {LEGAL_DOCUMENTS.map((document) => (
          <li key={document.href} className="mt-0!">
            <Link
              href={document.href}
              className="group flex h-full flex-col rounded-[2rem] border border-border bg-card p-6 text-foreground! no-underline! shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)] transition-colors hover:border-brand-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <span className="flex items-start justify-between gap-3 font-semibold text-foreground">
                {document.title}
                <ArrowRight
                  className="mt-1 size-4 shrink-0 text-brand-ink transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
              <span className="mt-2 block text-sm font-normal text-muted-foreground">
                {document.summary}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </LegalPage>
  )
}
