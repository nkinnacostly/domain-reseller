import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage } from '@/features/legal/components/legal-page'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Legal',
  description: `The agreements and policies that apply when you register a domain with ${BUSINESS.brand}.`,
}

export default function LegalIndexPage() {
  return (
    <LegalPage
      title="Legal"
      nav="none"
      intro={<p>The agreements and policies that apply when you register a domain with us.</p>}
    >
      <ul className="mt-0! list-none! space-y-0! divide-y divide-border/70 rounded-2xl border border-border pl-0!">
        {LEGAL_DOCUMENTS.map((document) => (
          <li key={document.href} className="mt-0!">
            <Link
              href={document.href}
              className="block px-5 py-4 no-underline! transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            >
              <span className="font-semibold text-foreground underline-offset-4">
                {document.title}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">{document.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </LegalPage>
  )
}
