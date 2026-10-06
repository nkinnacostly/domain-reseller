'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { QUIET_BUTTON } from '@/features/admin/components/confirm-action'
import { AdminPage } from '@/features/admin/components/parts'

/** An admin page that failed: the shell stays, with "Try again" and a way back (S11). */
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
    <AdminPage title="This admin page couldn't be shown">
      <p className="max-w-xl text-sm/6 text-muted-foreground">
        Nothing was changed. Try again; if it keeps failing, SES health says whether the worker is
        reporting.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={reset} className={QUIET_BUTTON}>
          Try again
        </button>
        <Link href="/admin" className={QUIET_BUTTON}>
          Back to the admin overview
        </Link>
      </div>
    </AdminPage>
  )
}
