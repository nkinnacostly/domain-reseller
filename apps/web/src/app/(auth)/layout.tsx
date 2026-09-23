import { formatNaira } from '@dr/shared'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { FloatingIcon } from '@/components/layout/page-hero'
import { Container } from '@/components/layout/site-shell'
import { getNameserverPresets } from '@/features/domains/queries/domains'
import { PhoneFrame } from '@/features/marketing/components/phone-frame'
import { DomainsScreen } from '@/features/marketing/components/phone-screens'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * Auth pages: the brand, a way back, and the form — nothing to wander off
 * into. On wide screens the blue panel from the home page sits beside the
 * form, showing where signing in leads: your domains. It is decorative, and
 * its price is the live renewal price, like every price on the site (N5b).
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const [priced, presets] = await Promise.all([getPricedCatalogue(), getNameserverPresets()])
  const lead = priced?.featured[0]

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.05fr]">
      <div className="flex min-w-0 flex-col">
        <header>
          <Container className="flex items-center justify-between gap-4 py-5 sm:py-6">
            <Link
              href="/"
              aria-label={`${BRAND_NAME} home`}
              className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <Brand />
            </Link>
            <Link
              href="/"
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              {/* The full label wraps beside the wordmark on a phone. */}
              <span className="sm:hidden">Home</span>
              <span className="hidden sm:inline">Back to site</span>
            </Link>
          </Container>
        </header>
        <main id="main" className="flex flex-1 items-start sm:items-center">
          <Container className="w-full py-8 sm:py-14">{children}</Container>
        </main>
      </div>

      <div aria-hidden="true" className="hidden select-none p-5 lg:block">
        <div className="sticky top-5 flex h-[calc(100dvh-2.5rem)] min-h-[40rem] flex-col overflow-hidden rounded-[2.5rem] bg-brand text-brand-foreground">
          <div className="absolute bottom-0 left-1/2 aspect-square w-[56rem] -translate-x-1/2 translate-y-[64%] rounded-full bg-brand-arc/55" />
          <FloatingIcon emoji="🔒" className="top-[14%] left-[8%] size-16 text-3xl -rotate-6" />
          <FloatingIcon
            emoji="🌍"
            className="top-[10%] right-[10%] size-[4.5rem] text-4xl rotate-6"
            delay="1.4s"
          />
          <FloatingIcon
            emoji="✅"
            className="top-[42%] right-[6%] size-14 text-2xl rotate-3"
            delay="2.8s"
          />

          <div className="relative mx-auto max-w-md px-10 pt-24 text-center">
            <p className="text-4xl leading-[1.1] font-bold tracking-[-0.02em] text-balance">
              The domain you want, priced in naira
            </p>
            <p className="mt-4 text-pretty text-brand-muted-foreground">
              Your domains, their renewal prices and where they point — in one place.
            </p>
          </div>

          <div className="relative mt-auto h-[22rem]">
            <PhoneFrame className="absolute top-0 left-1/2 -translate-x-1/2">
              <DomainsScreen
                lead={
                  lead
                    ? {
                        tld: lead.tld,
                        firstYear: formatNaira(lead.registration.priceKobo),
                        renewal: formatNaira(lead.renewal.priceKobo),
                      }
                    : null
                }
                host={presets[0]?.provider ?? null}
              />
            </PhoneFrame>
          </div>
        </div>
      </div>
    </div>
  )
}
