'use client'

import { useEffect } from 'react'
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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        We hit an unexpected error. Nothing has been charged. Try again, or contact support if it
        keeps happening.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
