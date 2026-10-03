'use client'

import type { AdminSslStatus } from '@dr/shared/admin'
import { RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { Spinner } from '@/components/ui/spinner'
import { lookupSsl } from '@/features/admin/actions/supplier-live'
import { adminOutcome } from '@/features/admin/lib/errors'
import { CHECK_STATUS_LABEL, statusReadWords } from '@/features/admin/lib/ssl-copy'

/**
 * "Check status now": one read of the certificate from DomainNameAPI, on a
 * click — never on render (D10, D22). The action writes an audited note
 * first and the gateway claims it before asking the supplier, in the normal
 * lane. What it found is said in our words (N10); the page then re-reads, so
 * the read shows in the supplier calls.
 */
export function CheckStatus({ name, returnTo }: { name: string; returnTo: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [words, setWords] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onClick() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome<AdminSslStatus>(await lookupSsl({ name }))
      if (!result.ok) {
        setError(result.message)
      } else if (!result.data) {
        setError('DomainNameAPI answered nothing we could read. Nothing was changed; try again.')
      } else {
        setWords(statusReadWords(result.data))
        router.refresh()
      }
    } catch {
      setError("The read didn't come back. Nothing was changed; try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-busy={pending || undefined}
        className={QUIET_BUTTON}
      >
        {pending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        {CHECK_STATUS_LABEL}
      </button>
      <p role="status" className="text-sm text-foreground empty:hidden">
        {words ?? ''}
      </p>
      <ActionError message={error} returnTo={returnTo} />
    </div>
  )
}
