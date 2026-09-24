import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import Link from 'next/link'
import { FaqItem } from '@/components/common/faq-item'
import { Container } from '@/components/layout/site-shell'
import { Accordion } from '@/components/ui/accordion'
import { BUSINESS } from '@/lib/business'

export const HOME_FAQS = [
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
    a: 'Most extensions give you a grace period after expiry — often 30 days — when you can still renew at the normal price. After that the domain enters redemption, where it can be recovered only by paying the registry’s restore fee as well. Your account shows every domain’s expiry date, and you can renew any domain there before that date at the renewal price shown.',
  },
  {
    q: 'Can I transfer a domain I already own?',
    a: `Yes. It must be at least ${TRANSFER_LOCK_DAYS} days old, unlocked at your current registrar, and you need its authorisation code. Our transfer checker looks it up and tells you what, if anything, is in the way — then you enter the code, we check it with the registry, and you pay. Transfers usually take up to five days.`,
  },
  {
    q: 'Can I move my domain away later?',
    a: 'Always. We release your authorisation code within five days of you asking, and we never withhold it over an unpaid invoice. A domain you bought is yours.',
  },
] as const

export function Faq() {
  return (
    <section aria-labelledby="faq-heading">
      <Container className="py-16 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <div>
            <p className="text-sm font-semibold text-brand-ink">FAQ</p>
            <h2
              id="faq-heading"
              className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
            >
              Questions people actually ask
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              Still stuck? The{' '}
              <Link
                href="/help"
                className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                help centre
              </Link>{' '}
              goes further, or email{' '}
              <a
                href={`mailto:${BUSINESS.email}`}
                className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {BUSINESS.email}
              </a>
              .
            </p>
          </div>

          <Accordion
            type="single"
            collapsible
            className="w-full rounded-[2rem] border border-brand-subtle-border bg-brand-subtle px-6 py-2 sm:px-8"
          >
            {HOME_FAQS.map((faq) => (
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
