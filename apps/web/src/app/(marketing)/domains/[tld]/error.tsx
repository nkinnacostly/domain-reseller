'use client'

import Link from 'next/link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteHeader } from '@/components/layout/site-header'
import { Button } from '@/components/ui/button'

/**
 * An extension page whose catalogue and prices could not be read (FR-PUB1):
 * we cannot even say whether we sell it, so we say that, and offer a retry —
 * never a guess (N5b).
 */
export default function ExtensionError({ reset }: { reset: () => void }) {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          eyebrow="Domain extensions"
          title="This extension is briefly unavailable"
          intro={
            <p>
              We could not read our catalogue just now, and would rather show you nothing than
              something wrong. Try again in a minute, or{' '}
              <Link href="/pricing">see every price</Link>.
            </p>
          }
        >
          <Button
            onClick={reset}
            size="lg"
            className="h-12 rounded-full bg-brand-foreground px-6 text-brand hover:bg-brand-muted-foreground focus-visible:ring-brand-foreground/60 active:scale-[0.98]"
          >
            Try again
          </Button>
        </PageHero>
      </main>
    </>
  )
}
