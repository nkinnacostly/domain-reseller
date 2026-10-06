import { CurrencyNgn, Gauge, Receipt } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { PageHero } from '@/features/marketing/components/page-hero'
import { PreLaunchNotice } from '@/features/marketing/components/pre-launch-notice'
import { CapRules, PricingFaq } from '@/features/pricing/components/cap-rules'
import { PlanCards } from '@/features/pricing/components/plan-cards'
import { PRICING_INTRO, pricingFaqs } from '@/features/pricing/lib/copy'
import { getPlanCatalogue } from '@/features/pricing/queries/plans'
import { PageJsonLd } from '@/features/seo/components/json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { faqPageLd, plansServiceLd } from '@/features/seo/lib/structured-data'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  description:
    'Mail plans priced in naira: each with its monthly and daily cap, counted per recipient, and what happens at the cap. Before VAT.',
  path: '/pricing',
})

/**
 * Pricing (MAIL-SPEC §8, §10). The plans are rows in `mail.plans`, read
 * through the cookie-free client behind `'use cache'`, so the page
 * prerenders and changes when a plan does. Scale stays off the page while
 * `is_offered` is false (§4.4).
 */
export default async function PricingPage() {
  const catalogue = await getPlanCatalogue()
  const faqs = pricingFaqs(catalogue)

  return (
    <>
      <PageJsonLd
        trail={[{ name: 'Pricing', path: '/pricing' }]}
        extra={[
          plansServiceLd(env.NEXT_PUBLIC_MAIL_URL, {
            plans: catalogue?.plans ?? [],
            description: PRICING_INTRO,
          }),
          faqPageLd(faqs),
        ]}
      />
      <PageHero
        eyebrow="Pricing"
        title="Plans priced in naira, with every cap in plain sight"
        intro={<p>{PRICING_INTRO}</p>}
        icons={[CurrencyNgn, Gauge, Receipt]}
      />
      <PreLaunchNotice />
      <PlanCards catalogue={catalogue} />
      <CapRules />
      <PricingFaq faqs={faqs} />
    </>
  )
}
