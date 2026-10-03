'use client'

import type { AdminRegistrantVerification, AdminRegistryDomain } from '@dr/shared/admin'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { Spinner } from '@/components/ui/spinner'
import { lookupDomain, readRegistrantVerification } from '@/features/admin/actions/supplier-live'
import { DiffTable } from '@/features/admin/components/diff-table'
import {
  liveComparison,
  type Ours,
  REGISTRY,
  storedComparison,
  VERIFICATION,
  verificationWords,
} from '@/features/admin/lib/domains-copy'
import { adminOutcome } from '@/features/admin/lib/errors'

/**
 * The domain page's live reads (§5.2 B9, D10, D22): on a click, never on
 * render. Each action writes an audited note first and the gateway claims it
 * before asking the registry. What came back is said in words, from the
 * gateway's allowlisted shape — never the supplier's own text (N10).
 */

function ReadButton({
  label,
  pending,
  onClick,
}: {
  label: string
  pending: boolean
  onClick: () => void
}) {
  return (
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
      {label}
    </button>
  )
}

/**
 * "Ours vs Registry": what the hourly check stored, until someone reads the
 * registry now — then every field the read returned, each marked when it
 * differs (in words, not colour alone: S8).
 */
export function RegistryCompare({
  name,
  ours,
  stored,
  readOff,
  returnTo,
}: {
  name: string
  ours: Ours
  stored: { registryStatus: string | null; checkedAt: string | null }
  /** Why the registry can't be read from here (a role, a demo row); undefined when it can. */
  readOff?: string | undefined
  returnTo: string
}) {
  const [read, setRead] = useState<AdminRegistryDomain | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onRead() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome<AdminRegistryDomain>(await lookupDomain({ name }))
      if (!result.ok) setError(result.message)
      else if (!result.data) setError(REGISTRY.nothing)
      else setRead(result.data)
    } catch {
      setError(REGISTRY.lost)
    } finally {
      setPending(false)
    }
  }

  const rows = read ? liveComparison(ours, read) : storedComparison(ours, stored)
  const differing = rows.filter((row) => row.differs).length
  const caption = read
    ? REGISTRY.liveCaption(read.readAt)
    : REGISTRY.storedCaption(stored.checkedAt)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{caption}.</p>
      <DiffTable caption={caption} rows={rows} />
      <p role="status" className="text-sm text-foreground empty:hidden">
        {read ? (differing === 0 ? REGISTRY.same : REGISTRY.differs(differing)) : ''}
      </p>
      {readOff ? (
        <p className="text-sm text-muted-foreground">{readOff}</p>
      ) : (
        <div className="space-y-2">
          <ReadButton label={REGISTRY.read} pending={pending} onClick={onRead} />
          <p className="max-w-2xl text-xs text-muted-foreground">{REGISTRY.hint}</p>
          <ActionError message={error} returnTo={returnTo} />
        </div>
      )}
    </div>
  )
}

/** Whether the registrant confirmed their email with the registry (ICANN), read on a click. */
export function VerificationRead({
  name,
  canRead,
  returnTo,
}: {
  name: string
  canRead: boolean
  returnTo: string
}) {
  const [words, setWords] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canRead) return <p className="text-sm text-muted-foreground">{VERIFICATION.roleOnly}</p>

  async function onRead() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome<AdminRegistrantVerification | null>(
        await readRegistrantVerification({ name }),
      )
      if (result.ok) setWords(verificationWords(result.data ?? null))
      else setError(result.message)
    } catch {
      setError(REGISTRY.lost)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <ReadButton label={VERIFICATION.read} pending={pending} onClick={onRead} />
      <p className="max-w-2xl text-xs text-muted-foreground">{VERIFICATION.hint}</p>
      <p role="status" className="text-sm text-foreground empty:hidden">
        {words ?? ''}
      </p>
      <ActionError message={error} returnTo={returnTo} />
    </div>
  )
}
