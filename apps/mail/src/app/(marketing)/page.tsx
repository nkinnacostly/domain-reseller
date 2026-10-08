import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/components/layout/brand'
import { Deliverability } from '@/features/marketing/components/deliverability'
import { FinalCta } from '@/features/marketing/components/final-cta'
import { Hero } from '@/features/marketing/components/hero'
import { HowItWorks } from '@/features/marketing/components/how-it-works'
import { PlansTeaser } from '@/features/marketing/components/plans-teaser'
import { PreLaunchNotice } from '@/features/marketing/components/pre-launch-notice'
import { WaysToSend } from '@/features/marketing/components/ways-to-send'
import { freePlan } from '@/features/pricing/lib/plans'
import { getPlanCatalogue } from '@/features/pricing/queries/plans'
import { JsonLd } from '@/features/seo/components/json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { graph, organizationLd, websiteLd } from '@/features/seo/lib/structured-data'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: `${PRODUCT_NAME} — transactional email for Nigerian businesses`,
  absolute: true,
  description:
    'Send receipts, sign-in links and alerts from your own domain with one HTTP call, or over SMTP from WordPress, Laravel or Django. Start on the Free plan, no card needed; paid plans priced in naira, every cap shown.',
  path: '/',
})

/** The home page (MAIL-SPEC §10): what Mail is and its Free plan, the call, how it works, the API or SMTP, what protects you. */
export default async function HomePage() {
  const catalogue = await getPlanCatalogue()
  const free = catalogue ? freePlan(catalogue.plans) : null
  const site = env.NEXT_PUBLIC_MAIL_URL

  return (
    <>
      <JsonLd data={graph(organizationLd(site), websiteLd(site))} />
      <Hero free={free} />
      <PreLaunchNotice />
      <HowItWorks />
      <WaysToSend />
      <Deliverability />
      <PlansTeaser catalogue={catalogue} />
      <FinalCta hasFreePlan={free !== null} />
    </>
  )
}
