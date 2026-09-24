import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Help centre',
  description: `Answers about buying, pointing, protecting and renewing a domain with ${BUSINESS.brand}.`,
}

/**
 * Help centre. Every answer describes what the product does today (N9b) —
 * where something is not built (automatic renewal, starting a transfer), it says
 * so and gives the way that works now.
 */
const TOPICS: { id: string; title: string; questions: { q: string; a: React.ReactNode }[] }[] = [
  {
    id: 'buying',
    title: 'Buying a domain',
    questions: [
      {
        q: 'How do I check whether a domain is free?',
        a: (
          <p>
            Type the name you want into the search on the <Link href="/">home page</Link>. You see
            straight away whether your exact name is free, then the same name across other
            extensions, and suggestions if it is taken.
          </p>
        ),
      },
      {
        q: 'What does it cost?',
        a: (
          <p>
            Every price is in naira and shown next to its renewal price, so you know what next year
            costs. VAT at 7.5% is added at checkout as its own line. Prices follow the supplier’s
            dollar price and the day’s exchange rate. If a price changes after you add a domain to
            your cart, the cart tells you before you pay. See all prices on the{' '}
            <Link href="/pricing">pricing page</Link>.
          </p>
        ),
      },
      {
        q: 'How can I pay?',
        a: (
          <p>
            Checkout takes you to Flutterwave, where you can pay by card, bank transfer or the other
            methods Flutterwave offers. We never see your card details.
          </p>
        ),
      },
      {
        q: 'Do I need an account?',
        a: (
          <p>
            Not to search or fill a cart. You sign in when you check out, and your cart comes with
            you.
          </p>
        ),
      },
    ],
  },
  {
    id: 'after',
    title: 'After you pay',
    questions: [
      {
        q: 'How long does registration take?',
        a: (
          <p>
            Usually under a minute. Your order page updates by itself from “Queued” to “Registered”.
          </p>
        ),
      },
      {
        q: 'What if a registration fails?',
        a: (
          <p>
            Your order shows which domain failed and why — for example, someone registered it
            moments before you. You get the full amount back within {BUSINESS.refundBusinessDays}{' '}
            business days. See the <Link href="/legal/refunds">refund policy</Link>.
          </p>
        ),
      },
      {
        q: 'Where do I find my domains?',
        a: (
          <p>
            Under <Link href="/app/domains">your domains</Link>, with each one’s status and expiry
            date. The “Expiring in 30 days” view shows what needs attention first.
          </p>
        ),
      },
    ],
  },
  {
    id: 'pointing',
    title: 'Pointing your domain at your website',
    questions: [
      {
        q: 'What are nameservers?',
        a: (
          <p>
            They tell the internet who answers for your domain — usually your web host. Point the
            domain at your host’s nameservers and the host takes care of your website and email
            records.
          </p>
        ),
      },
      {
        q: 'How do I change them?',
        a: (
          <>
            <p>
              Open the domain, go to the <strong>Nameservers</strong> tab, pick your host from the
              list or paste the nameservers it gave you, and save. For your security this needs
              two-factor authentication, which you can turn on in Settings.
            </p>
            <p>
              The registry usually applies the change within a minute. Other networks catch up as
              their cached answers expire, which can take a few hours. The tab shows what public DNS
              services currently see.
            </p>
          </>
        ),
      },
      {
        q: 'Can you host my website or email?',
        a: (
          <p>
            No — we register and manage domains. Point your domain at the company that hosts your
            website or email, or at a DNS service such as Cloudflare to manage records yourself.
          </p>
        ),
      },
    ],
  },
  {
    id: 'security',
    title: 'Keeping your domain safe',
    questions: [
      {
        q: 'What is transfer lock?',
        a: (
          <p>
            It stops anyone moving your domain to another registrar without your say-so. It is on
            from registration.
          </p>
        ),
      },
      {
        q: 'Should I turn on two-factor authentication?',
        a: (
          <p>
            Yes. It protects your account with a code from an app on your phone, and it is required
            for sensitive changes such as nameservers.
          </p>
        ),
      },
      {
        q: 'How do I sign out a device I no longer use?',
        a: (
          <p>
            Settings lists every device signed in to your account. Sign out any one of them, or all
            but the one you are using. A device you sign out can keep working for up to an hour,
            until its current sign-in token expires.
          </p>
        ),
      },
      {
        q: 'Is my address shown publicly?',
        a: (
          <p>
            Where the extension allows it, contact privacy keeps your personal details out of the
            public registration record, free of charge. See the{' '}
            <Link href="/legal/privacy">privacy notice</Link>.
          </p>
        ),
      },
    ],
  },
  {
    id: 'renewals',
    title: 'Renewals and expiry',
    questions: [
      {
        q: 'How do I renew?',
        a: (
          <p>
            Open the domain in your account and choose Renew. Pick how many years to add, check the
            total, and pay on Flutterwave’s page. The years are added to the current expiry date,
            and the domain’s page shows the new date once the registry confirms it. The auto-renew
            switch records what you want; automatic renewal is not switched on yet, so nothing is
            charged unless you pay for it. A domain already in redemption needs a restore — email{' '}
            <EmailLink /> for its cost.
          </p>
        ),
      },
      {
        q: 'What happens if my domain expires?',
        a: (
          <p>
            It usually stops working. For a while it can still be renewed at the normal price, then
            only restored for an extra registry fee, and after that anyone can register it. The{' '}
            <Link href="/legal/registration-agreement#term">registration agreement</Link> explains
            the stages.
          </p>
        ),
      },
    ],
  },
  {
    id: 'transfers',
    title: 'Transfers',
    questions: [
      {
        q: 'Can I transfer a domain to you?',
        a: (
          <p>
            You can <Link href="/transfer">check whether a domain can move</Link> now. Starting a
            transfer is not available yet.
          </p>
        ),
      },
      {
        q: 'How do I move a domain away?',
        a: (
          <p>
            Email <EmailLink /> for the transfer code and we send it within five days. A domain
            cannot usually move for {TRANSFER_LOCK_DAYS} days after it is registered or changes
            owner. We never hold a domain back over a billing dispute.
          </p>
        ),
      },
    ],
  },
]

export default function HelpPage() {
  return (
    <LegalPage
      title="Help centre"
      nav="none"
      icons={['💬', '📘', '✅']}
      intro={
        <p>
          Answers to common questions. Cannot find yours? <Link href="/contact">Contact us</Link>.
        </p>
      }
    >
      {TOPICS.map((topic) => (
        <LegalSection key={topic.id} id={topic.id} title={topic.title}>
          <Accordion type="multiple" className="mt-2 w-full">
            {topic.questions.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger className="text-left text-base font-medium">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-pretty text-[0.95rem]/7 text-muted-foreground [&_p:first-child]:mt-0">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </LegalSection>
      ))}
    </LegalPage>
  )
}
