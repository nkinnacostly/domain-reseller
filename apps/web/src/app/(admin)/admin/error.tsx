'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { PanelPage } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'

/** An admin page that failed: the shell stays, with "Try again" and a way back. */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The digest only: the message may name a record (N13).
    console.error('admin page error', error.digest)
  }, [error])

  return (
    <PanelPage>
      <ErrorState
        title="This admin page couldn't be shown."
        body="Nothing was changed. Try again; if it keeps failing, the alerts page says what is down."
        retry={reset}
      />
      <Link href="/admin" className="text-sm text-foreground underline underline-offset-4">
        Back to the admin overview
      </Link>
    </PanelPage>
  )
}
