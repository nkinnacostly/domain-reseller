'use client'

import type { AdminRegistryDomain, AdminRenewCheck, AdminTransferState } from '@dr/shared/admin'
import { RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { Spinner } from '@/components/ui/spinner'
import {
  checkRenewable,
  lookupDomain,
  readTransferState,
} from '@/features/admin/actions/supplier-live'
import { adminOutcome } from '@/features/admin/lib/errors'
import {
  registryReadWords,
  renewCheckWords,
  transferStateWords,
} from '@/features/admin/lib/jobs-copy'

export type LiveReadKind = 'registry' | 'transfer' | 'renew'

export const LIVE_READ_LABEL: Readonly<Record<LiveReadKind, string>> = {
  registry: 'Read the registry now',
  transfer: 'Read the transfer state',
  renew: 'Check renewability',
}

async function read(kind: LiveReadKind, name: string): Promise<{ words?: string; error?: string }> {
  switch (kind) {
    case 'registry': {
      const result = adminOutcome<AdminRegistryDomain>(await lookupDomain({ name }))
      return result.ok
        ? result.data
          ? { words: registryReadWords(result.data) }
          : { error: 'The registry answered nothing we could read.' }
        : { error: result.message }
    }
    case 'transfer': {
      const result = adminOutcome<AdminTransferState>(await readTransferState({ name }))
      return result.ok
        ? result.data
          ? { words: transferStateWords(result.data) }
          : { error: 'The registry answered nothing we could read.' }
        : { error: result.message }
    }
    case 'renew': {
      const result = adminOutcome<AdminRenewCheck>(await checkRenewable({ name }))
      return result.ok
        ? result.data
          ? { words: renewCheckWords(result.data) }
          : { error: 'The registry answered nothing we could read.' }
        : { error: result.message }
    }
  }
}

/**
 * One live read, on a click — never on render (D10, D22). The action writes
 * an audited note first and the gateway claims it before asking the
 * supplier. What it found is said in words; the page then re-reads, so a
 * read the gateway recorded counts toward Fail's precondition at once.
 */
export function LiveRead({
  kind,
  name,
  returnTo,
}: {
  kind: LiveReadKind
  name: string
  returnTo: string
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [words, setWords] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onClick() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const answer = await read(kind, name)
      if (answer.words) {
        setWords(answer.words)
        router.refresh()
      } else {
        setError(answer.error ?? null)
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
        {LIVE_READ_LABEL[kind]}
      </button>
      <p role="status" className="text-sm text-foreground empty:hidden">
        {words ?? ''}
      </p>
      <ActionError message={error} returnTo={returnTo} />
    </div>
  )
}
