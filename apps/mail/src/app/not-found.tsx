import Link from 'next/link'
import { MarketingFooter } from '@/features/marketing/components/marketing-footer'
import { MarketingHeader } from '@/features/marketing/components/marketing-header'
import { PageHero } from '@/features/marketing/components/page-hero'

/** A path no page answers: the public frame, what happened, and the way home. */
export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <MarketingHeader />
      <main id="main" className="flex-1">
        <PageHero
          title="This page is not here"
          intro="The address may be mistyped, or the page may have moved."
        >
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand-foreground px-6 text-sm font-medium text-brand transition-colors hover:bg-brand-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:scale-[0.98]"
          >
            Go to the home page
          </Link>
        </PageHero>
      </main>
      <MarketingFooter />
    </div>
  )
}
