import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { TransferCheckForm } from '@/features/transfers/components/transfer-check-form'
import { TransferFaq } from '@/features/transfers/components/transfer-faq'
import { TransferGuide } from '@/features/transfers/components/transfer-guide'
import { TransferPrices } from '@/features/transfers/components/transfer-prices'
import { TransferResult } from '@/features/transfers/components/transfer-result'

export const metadata: Metadata = {
  title: 'Transfer a domain',
  description:
    'Check whether your domain can move. We look it up at the registry and tell you exactly what, if anything, is in the way.',
}

/**
 * Transfer-in landing and eligibility check (PRD §14 route map, FR-T1).
 *
 * The shell prerenders; only the result reads `?domain=`, inside Suspense.
 * No fallback: until someone checks a domain there is nothing to hold space
 * for, and the button shows the check is running.
 */
export default function TransferPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string | string[] }>
}) {
  return (
    <>
      <SiteHeader />

      <main id="main">
        <PageHero
          eyebrow="Transfer"
          title="Bring your domain here"
          intro="Check whether it can move. We look it up at the registry and tell you exactly what, if anything, is in the way."
          icons={['🔁', '🔓', '✅']}
        >
          <TransferCheckForm />
        </PageHero>

        <Suspense fallback={null}>
          <TransferResult searchParams={searchParams} />
        </Suspense>

        <TransferGuide />
        <TransferPrices />
        <TransferFaq />
      </main>

      <SiteFooter />
    </>
  )
}
