import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { TransferCheckForm } from '@/features/transfers/components/transfer-check-form'
import { TransferFaq } from '@/features/transfers/components/transfer-faq'
import { TransferGuide } from '@/features/transfers/components/transfer-guide'
import { TransferPrices } from '@/features/transfers/components/transfer-prices'
import { TransferResult } from '@/features/transfers/components/transfer-result'

export const metadata: Metadata = {
  title: 'Transfer a domain',
  description:
    'Check whether your domain can move before you pay anything. We look it up at the registry and tell you exactly what, if anything, is in the way.',
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
      <SiteHeader className="border-border/60 border-b" />

      <main id="main">
        <div className="bg-gradient-to-br from-hero-from to-hero-to">
          <Container className="py-14 sm:py-20">
            <div className="max-w-2xl">
              <h1 className="text-[2.25rem] leading-[1.08] font-bold tracking-[-0.02em] text-balance sm:text-5xl">
                Bring your domain here
              </h1>
              <p className="mt-5 text-pretty text-muted-foreground">
                Check whether it can move before you pay anything. We look it up at the registry and
                tell you exactly what, if anything, is in the way.
              </p>
              <div className="mt-8">
                <TransferCheckForm />
              </div>
            </div>
          </Container>
        </div>

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
