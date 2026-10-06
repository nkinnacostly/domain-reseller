'use client'

import { Container } from '@/components/layout/container'

/**
 * A dashboard page that failed to render (S11), inside the shell: what
 * happened, that nothing changed, and the one thing to try.
 */
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Container className="py-8 sm:py-10">
      <div
        role="alert"
        className="max-w-xl rounded-3xl bg-tone-danger p-6 text-tone-danger-foreground"
      >
        <h1 className="text-xl font-semibold">This page could not load</h1>
        <p className="mt-2 text-pretty text-sm/6">
          Nothing in your account has changed. Try again in a moment; if it keeps happening, write
          to hello@mydomainshub.com.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Try again
        </button>
      </div>
    </Container>
  )
}
