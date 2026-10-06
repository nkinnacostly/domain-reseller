'use client'

import { Container } from '@/components/layout/container'
import { Button } from '@/components/ui/button'

/** A page that failed to render: what happened, and the one thing to try (S11). */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <Container className="py-16 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-3 max-w-xl text-muted-foreground">
        This page could not load. Nothing you entered was lost. Try again in a moment.
      </p>
      <Button type="button" className="mt-6 min-h-11" onClick={reset}>
        Try again
      </Button>
    </Container>
  )
}
