import { SSL_TERM } from '@dr/shared'
import Link from 'next/link'
import { FaqItem } from '@/components/common/faq-item'
import { Container } from '@/components/layout/site-shell'
import { Accordion } from '@/components/ui/accordion'

/**
 * The plain facts before anyone buys (FR-SSL-1, N9b): many hosts already
 * give a certificate free, you install this one yourself, and how long it
 * really lasts. Every answer here describes what the product does.
 */

export const SSL_FAQS: { q: string; a: string }[] = [
  {
    q: 'Do I need to buy one?',
    a: 'Often not. Vercel, Netlify and Cloudflare set up a certificate for your site automatically, and many web hosts — Hostinger and most cPanel hosts among them — include one free. Check your host first. Buy one here when your host does not provide one, or for a server you run yourself.',
  },
  {
    q: 'How long does it last?',
    a: `${SSL_TERM.long} It never renews by itself: when the subscription ends, you buy a new certificate at the price shown then.`,
  },
  {
    q: 'Who installs it?',
    a: 'You do. Once it is issued you download the certificate and its chain from your account and add them, with your private key, in your host’s or server’s SSL settings. We do not install certificates or host websites.',
  },
  {
    q: 'How is it approved?',
    a: 'By email. When you set it up you choose one of the addresses the certificate authority offers for your domain — admin@, administrator@, hostmaster@, postmaster@ or webmaster@ — and it emails a link there. The mailbox has to exist, so create one with your email host first if you need to.',
  },
  {
    q: 'Does my domain have to be registered with you?',
    a: 'No. A certificate can be for any domain you control, wherever it is registered — what matters is that you can read email at one of the approval addresses.',
  },
  {
    q: 'Can you make the private key and CSR for me?',
    a: 'Yes, if you prefer: our supplier makes them, and we show you the key once to copy or download. We do not store or log it, and nobody can show it to you again. The safest way is still to make the CSR on your own server, so the key never leaves it.',
  },
  {
    q: 'What if something goes wrong?',
    a: 'If we cannot order the certificate from the certificate authority, you get back what you paid for it, automatically. Once it is ordered it is not refundable, but you can reissue it free during the subscription. If its key is lost or stolen, email us and we ask the certificate authority’s supplier to revoke it.',
  },
]

export function SslGuide() {
  return (
    <section aria-labelledby="ssl-faq-heading">
      <Container className="py-16 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <div>
            <h2
              id="ssl-faq-heading"
              className="text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
            >
              Before you buy
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              The full terms are in the{' '}
              <Link
                href="/legal/registration-agreement#ssl"
                className="underline underline-offset-4 hover:text-foreground"
              >
                agreement’s SSL section
              </Link>{' '}
              and the{' '}
              <Link
                href="/legal/refunds#ssl"
                className="underline underline-offset-4 hover:text-foreground"
              >
                refund policy
              </Link>
              .
            </p>
          </div>
          <Accordion
            type="multiple"
            className="w-full rounded-[2rem] border border-brand-subtle-border bg-brand-subtle px-6 py-2 sm:px-8"
          >
            {SSL_FAQS.map((faq) => (
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
