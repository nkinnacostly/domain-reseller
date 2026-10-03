'use client'

import { Check, Copy, KeyRound } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { useEffect, useState } from 'react'
import { ActionError, QUIET_BUTTON, useOutcome } from '@/components/common/action-parts'
import { onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { revealTransferCode } from '../actions/settings'
import { PanelNote } from './domain-badges'
import { NeedsTwoFactor } from './settings-parts'

/**
 * FR-DS5, FR-T5: the transfer code, fetched from the registry when asked
 * for, after a fresh second factor (SEC-2). It lives only in this
 * component's state: shown once, never stored (SEC-12). Nothing about
 * billing is checked on the way (N14).
 */
export function TransferCode({
  domainId,
  domain,
  unavailable,
  hasTwoFactor,
  testMode,
}: {
  domainId: string
  domain: string
  /** Why there is no code to give, or null when there is. */
  unavailable: string | null
  hasTwoFactor: boolean
  testMode: boolean
}) {
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const outcome = useOutcome()
  const reveal = useAction(revealTransferCode, {
    ...outcome.callbacks,
    onSuccess: (result) => {
      outcome.callbacks.onSuccess(result)
      if (result.data && 'code' in result.data) {
        setCode(result.data.code)
        setCopied(false)
      }
    },
  })

  // Leaving the page keeps it hidden in the router's cache, state and all
  // (Next 16): forget the code as soon as it is hidden, so it is gone when
  // the customer comes back — and gone from the page's DOM meanwhile.
  useEffect(() => () => setCode(null), [])

  if (unavailable) return <PanelNote title="No transfer code.">{unavailable}</PanelNote>
  if (!hasTwoFactor) {
    return (
      <NeedsTwoFactor>
        The transfer code lets anyone move this domain away, so it needs two-factor authentication
        on your account.
      </NeedsTwoFactor>
    )
  }

  if (code) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">Transfer code for {domain}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 rounded-xl border border-border bg-background px-4 py-3 font-mono text-base break-all text-foreground">
            {code}
          </code>
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
        <p role="status" className="text-pretty text-sm/6 text-muted-foreground">
          {copied ? 'Copied to your clipboard. ' : ''}
          We don’t keep it: once you hide it or leave this page it is gone. Ask again whenever you
          need it.
          {testMode ? ' It comes from the registrar’s test system and moves no real domain.' : ''}
        </p>
        <button type="button" className={QUIET_BUTTON} onClick={() => setCode(null)}>
          Hide the code
        </button>
      </div>
    )
  }

  return (
    <form
      aria-label="Get transfer code"
      className="space-y-3"
      onSubmit={onSubmitWith(() => reveal.execute({ domainId }))}
    >
      <SubmitButton
        pending={reveal.isPending}
        pendingLabel="Asking the registry…"
        className="sm:w-auto"
      >
        <KeyRound className="size-4" aria-hidden="true" />
        Get transfer code
      </SubmitButton>
      <ActionError message={outcome.error} returnTo={`/app/domains/${domain}/security`} />
    </form>
  )
}
