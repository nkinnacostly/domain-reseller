'use client'

import { useSearchParams } from 'next/navigation'
import { Container } from '@/components/layout/site-shell'

/**
 * The loading state for a lookup opened from a link (S11). It is the page's
 * Suspense fallback, which is prerendered without knowing the URL — so it
 * checks for `?domain=` itself, and a visitor who has asked nothing sees no
 * skeleton at all. A lookup from the form shows its pending state on the
 * button instead.
 */
export function WhoisPending() {
  const domain = useSearchParams().get('domain')
  if (!domain?.trim()) return null

  return (
    <Container className="pt-12 sm:pt-16">
      <div role="status" aria-label="Looking up the domain" className="animate-pulse">
        <div className="h-4 w-28 rounded-full bg-muted" />
        <div className="mt-3 h-8 w-80 max-w-full rounded-xl bg-muted" />
        <div className="mt-8 h-64 rounded-[2rem] bg-muted/60" />
      </div>
    </Container>
  )
}
