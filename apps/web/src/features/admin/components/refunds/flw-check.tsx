'use client'

import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { useEffect, useId, useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { checkFlutterwaveRefund } from '@/features/admin/actions/supplier-live'
import { adminOutcome } from '@/features/admin/lib/errors'
import { CHECK_STEP, checkProblemWords, checkSummary } from '@/features/admin/lib/refunds-copy'
import { type CheckProblem, FLW_REFUND_ID } from '@/features/admin/lib/refunds-rules'
import { cn } from '@/lib/utils'

/**
 * Step one of recording a Flutterwave refund (ADMIN-SPEC §5.2 B3, D23): the
 * id from the Flutterwave dashboard, read from Flutterwave by the gateway —
 * an audited note first — and stored as a check the wrapper can trust for
 * 15 minutes. What comes back is ids, amounts and a status, nothing else.
 */

/** The time now, ticking while something on the page goes stale. */
export function useNow(active: boolean, everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs])
  return now
}

export type FlwCheckTarget = { refundId: string } | { incidentId: number }

export function FlwCheck({
  target,
  targetWord,
  check,
  problems,
  onCheck,
  returnTo,
  disabled = false,
}: {
  target: FlwCheckTarget
  /** "refund" or "incident": what the words say the check must match. */
  targetWord: string
  check: AdminFlwRefundCheck | null
  problems: CheckProblem[]
  onCheck: (check: AdminFlwRefundCheck | null) => void
  returnTo: string
  disabled?: boolean
}) {
  const id = useId()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const trimmed = value.trim()
  const valid = FLW_REFUND_ID.test(trimmed)
  const showInvalid = touched && trimmed !== '' && !valid

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    if (!valid || pending) return
    setPending(true)
    setError(null)
    onCheck(null)
    try {
      const result = adminOutcome(await checkFlutterwaveRefund({ flwRefundId: trimmed, ...target }))
      if (result.ok && result.data) onCheck(result.data)
      else if (!result.ok) setError(result.message)
    } catch {
      setError("We couldn't reach the gateway. Nothing was recorded. Try again.")
    } finally {
      setPending(false)
    }
  }

  const matches = check !== null && problems.length === 0

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:w-72">
          <label htmlFor={`${id}-flw`} className="text-sm font-medium text-foreground">
            {CHECK_STEP.idLabel}
          </label>
          <input
            id={`${id}-flw`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            disabled={disabled || pending}
            aria-invalid={showInvalid || undefined}
            aria-describedby={`${id}-flw-hint`}
            className={cn(inputClass, 'mt-1.5 font-mono')}
          />
          <p id={`${id}-flw-hint`} className="mt-1.5 text-xs text-muted-foreground">
            {showInvalid ? CHECK_STEP.idInvalid : CHECK_STEP.idHint}
          </p>
        </div>
        <button
          type="submit"
          disabled={disabled || pending || !valid}
          aria-busy={pending || undefined}
          className={cn(QUIET_BUTTON, 'sm:mb-6')}
        >
          {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
          {pending ? CHECK_STEP.pending : CHECK_STEP.button}
        </button>
      </form>

      <ActionError message={error} returnTo={returnTo} />

      {check ? (
        <div
          role="status"
          className={cn(
            'rounded-xl border px-3.5 py-3 text-sm',
            matches
              ? 'border-status-active/30 bg-status-active/10'
              : 'border-status-expiring/30 bg-status-expiring/10',
          )}
        >
          <p className="font-medium text-foreground">
            {matches ? 'Matches. ' : 'Does not match. '}
            <span className="font-normal">{checkSummary(check, matches, targetWord)}</span>
          </p>
          {problems.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground">
              {problems.map((problem) => (
                <li key={problem.kind}>{checkProblemWords(problem, targetWord)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
