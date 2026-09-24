import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'

/**
 * A question and its answer in an accordion, with the answer always in the
 * HTML. Radix unmounts a closed panel, which left every answer out of the page
 * that search engines and AI assistants read — they do not open accordions,
 * and most AI crawlers run no script at all. So the panel is force-mounted and
 * a closed one is hidden with CSS instead: the same to a person, readable to a
 * crawler. Use it inside an `Accordion`.
 */
export function FaqItem({
  question,
  children,
  className,
  answerClassName,
}: {
  question: string
  children: React.ReactNode
  className?: string
  answerClassName?: string
}) {
  return (
    <AccordionItem
      value={question}
      className={cn('[&>[data-slot=accordion-content][data-state=closed]]:hidden', className)}
    >
      <AccordionTrigger className="text-left text-base font-medium">{question}</AccordionTrigger>
      <AccordionContent forceMount className={answerClassName}>
        {children}
      </AccordionContent>
    </AccordionItem>
  )
}
