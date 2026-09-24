import { FaqItem } from '@/components/common/faq-item'
import { Container } from '@/components/layout/site-shell'
import { Accordion } from '@/components/ui/accordion'
import type { Faq } from '../lib/extension'

/** Short FAQ for one extension (FR-PUB1). Every answer is built from its data. */
export function ExtensionFaq({ tld, faqs }: { tld: string; faqs: Faq[] }) {
  return (
    <section aria-labelledby="extension-faq-heading">
      <Container className="py-16 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <h2
            id="extension-faq-heading"
            className="text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            .{tld} questions
          </h2>

          <Accordion
            type="single"
            collapsible
            className="w-full rounded-[2rem] border border-brand-subtle-border bg-brand-subtle px-6 py-2 sm:px-8"
          >
            {faqs.map((faq) => (
              <FaqItem
                key={faq.q}
                question={faq.q}
                className="border-brand-subtle-border"
                answerClassName="text-pretty text-sm/6 text-muted-foreground"
              >
                {faq.a}
              </FaqItem>
            ))}
          </Accordion>
        </div>
      </Container>
    </section>
  )
}
