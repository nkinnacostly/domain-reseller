import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { cn } from '@/lib/utils'

/**
 * A question and its answer, with the answer always in the HTML (CLAUDE.md
 * §15). Radix unmounts a closed panel, which would leave every answer out of
 * the page search engines and AI assistants read — they open nothing, and
 * most run no script. So the panel is force-mounted and a closed one hidden
 * with CSS: the same to a person, readable to a crawler.
 */
export function FaqItem({
  question,
  children,
  className,
}: {
  question: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <AccordionItem
      value={question}
      className={cn(
        'border-brand-subtle-border [&>[data-slot=accordion-content][data-state=closed]]:hidden',
        className,
      )}
    >
      <AccordionTrigger className="min-h-11 text-left text-base font-medium">
        {question}
      </AccordionTrigger>
      <AccordionContent forceMount className="text-pretty text-sm/6 text-muted-foreground">
        {children}
      </AccordionContent>
    </AccordionItem>
  )
}

export type Faq = { q: string; a: string }

/** Questions with plain-text answers — the same words the page's FAQ markup carries. */
export function FaqList({ faqs }: { faqs: readonly Faq[] }) {
  return (
    <Accordion
      type="single"
      collapsible
      className="w-full rounded-[2rem] border border-brand-subtle-border bg-brand-subtle px-6 py-2 sm:px-8"
    >
      {faqs.map((faq) => (
        <FaqItem key={faq.q} question={faq.q}>
          {faq.a}
        </FaqItem>
      ))}
    </Accordion>
  )
}
