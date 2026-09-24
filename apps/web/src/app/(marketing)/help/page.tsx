import type { Metadata } from 'next'
import Link from 'next/link'
import { FaqItem } from '@/components/common/faq-item'
import { Accordion } from '@/components/ui/accordion'
import { HELP_TOPICS } from '@/features/legal/components/help-topics'
import { LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { plainText } from '@/features/seo/lib/plain-text'
import { faqPageLd } from '@/features/seo/lib/structured-data'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Help centre',
  description: `Answers about buying, pointing, protecting and renewing a domain with ${BUSINESS.brand}.`,
  path: '/help',
})

export default function HelpPage() {
  return (
    <LegalPage
      path="/help"
      title="Help centre"
      nav="none"
      icons={['💬', '📘', '✅']}
      intro={
        <p>
          Answers to common questions. Cannot find yours? <Link href="/contact">Contact us</Link>.
        </p>
      }
      structuredData={[
        faqPageLd(
          HELP_TOPICS.flatMap((topic) =>
            topic.questions.map((item) => ({ q: item.q, a: plainText(item.a) })),
          ),
        ),
      ]}
    >
      {HELP_TOPICS.map((topic) => (
        <LegalSection key={topic.id} id={topic.id} title={topic.title}>
          <Accordion type="multiple" className="mt-2 w-full">
            {topic.questions.map((item) => (
              <FaqItem
                key={item.q}
                question={item.q}
                answerClassName="text-pretty text-[0.95rem]/7 text-muted-foreground [&_p:first-child]:mt-0"
              >
                {item.a}
              </FaqItem>
            ))}
          </Accordion>
        </LegalSection>
      ))}
    </LegalPage>
  )
}
