'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteHeader } from '@/components/layout/site-header'
import { Button } from '@/components/ui/button'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Report to our own Sentry, never the supplier SDK's.
    console.error(error)
  }, [error])

  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          title="Something went wrong"
          intro={
            <p>
              We hit an unexpected error. Nothing has been charged. Try again, or{' '}
              <Link href="/contact">contact us</Link> if it keeps happening.
            </p>
          }
        >
          <Button
            onClick={reset}
            size="lg"
            className="h-12 rounded-full bg-brand-foreground px-6 text-brand hover:bg-brand-muted-foreground focus-visible:ring-brand-foreground/60"
          >
            Try again
          </Button>
        </PageHero>
      </main>
    </>
  )
}
