'use client'

import { SiteFooter } from '@/components/layout/site-footer'
import { MarketingHeader } from '@/features/marketing/components/marketing-header'
import { PageHero } from '@/features/marketing/components/page-hero'

/**
 * A page that failed to render: what happened, and the one thing to try
 * (S11). The public frame — its footer is a server component, so the small
 * footer stands in for it here.
 */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <MarketingHeader />
      <main id="main" className="flex-1">
        <PageHero
          title="Something went wrong"
          intro="This page could not load. Nothing you entered was lost. Try again in a moment."
        >
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand-foreground px-6 text-sm font-medium text-brand transition-colors hover:bg-brand-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:scale-[0.98]"
          >
            Try again
          </button>
        </PageHero>
      </main>
      <SiteFooter />
    </div>
  )
}
