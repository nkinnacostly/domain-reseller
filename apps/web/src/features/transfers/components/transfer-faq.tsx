import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import { Container } from '@/components/layout/site-shell'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

const FAQS = [
  {
    q: 'Will my website go down during the transfer?',
    a: 'Not if your DNS is hosted with your web host. A transfer moves the registration; your nameservers come across unchanged. If your current registrar hosts your DNS records, copy them to your host before you start.',
  },
  {
    q: 'What happens to the time I have already paid for?',
    a: 'You keep it. For .com, .net, .org and other generic extensions, a transfer adds a year on top of your current expiry date, up to the ten-year maximum. Country extensions set their own rules.',
  },
  {
    q: 'How long does it take?',
    a: 'Up to five days once it is submitted. Your current registrar has five days to respond, and if they do not, the registry approves the transfer. Approving their confirmation email usually makes it quicker.',
  },
  {
    q: 'Can I transfer a domain I only just registered?',
    a: `Not straight away. Registrars can refuse a transfer for ${TRANSFER_LOCK_DAYS} days after a domain is registered or last transferred. The check above shows the exact date yours can move.`,
  },
  {
    q: 'Can I move it away again later?',
    a: 'Always. We release your auth code within five days of you asking, and we never hold it back over an unpaid invoice.',
  },
] as const

export function TransferFaq() {
  return (
    <section aria-labelledby="transfer-faq-heading" className="bg-muted/40">
      <Container className="py-14 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <h2
            id="transfer-faq-heading"
            className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
          >
            Transfer questions
          </h2>

          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((faq) => (
              <AccordionItem key={faq.q} value={faq.q}>
                <AccordionTrigger className="text-left text-base font-medium">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-pretty text-sm/6 text-muted-foreground">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Container>
    </section>
  )
}
