import { Container } from '@/components/layout/site-shell'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

const FAQS = [
  {
    q: 'Do I need hosting before I buy a domain?',
    a: "No. You can register a domain and point it somewhere later. Until you do, it simply won't resolve to a website — we'll show you exactly how to fix that whenever you're ready.",
  },
  {
    q: 'Can I use my domain with Cloudflare, Vercel or my existing host?',
    a: 'Yes, any of them. Pick your provider from our list and we fill in the nameservers for you, or paste the two your host gave you. We then check that the change actually took effect.',
  },
  {
    q: 'Why is the renewal price sometimes higher than the first year?',
    a: 'Some registries sell the first year cheaply to attract registrations, then charge full price afterwards. We always show both numbers so the second year is never a surprise.',
  },
  {
    q: 'What happens if I forget to renew?',
    a: 'There is a grace period after expiry — typically 30 days — where you can still renew at the normal price. After that the domain enters redemption, where recovery is possible but the registry charges a substantial fee. We send reminders by email, SMS and WhatsApp well before either point.',
  },
  {
    q: 'Can I transfer a domain I already own?',
    a: 'Yes, provided it is at least 60 days old, unlocked at your current registrar, and you have the authorisation code. Our transfer checker tells you which of those are true before you pay anything.',
  },
  {
    q: 'Can I move my domain away later?',
    a: 'Always. We release your authorisation code within five days of you asking, and we never withhold it over an unpaid invoice. A domain you bought is yours.',
  },
] as const

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" className="bg-muted/40">
      <Container className="py-14 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <div>
            <h2
              id="faq-heading"
              className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
            >
              Questions people actually ask
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              Still stuck? Our support team answers in English and replies to every message.
            </p>
          </div>

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
