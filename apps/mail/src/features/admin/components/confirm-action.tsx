'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { FormMessage, inputClass } from '@/components/common/form-parts'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'
import { type AdminResult, LOST_ANSWER_WORDS, UNKNOWN_OUTCOME } from '@/features/admin/lib/errors'
import { cn } from '@/lib/utils'

/**
 * Every admin action that changes something asks here first (the shop's
 * ADMIN-SPEC §5.1): a reason, kept in the audit log; and, for a money-tier
 * action (resume, cap overrides), the code from the authenticator app (D6),
 * verified by the server before anything reaches SQL.
 *
 * Each opening gets a request key. A refused answer gets a new one; a lost
 * answer keeps it, so trying again replays a change that went through rather
 * than making it twice (S12: pending, and a second press does nothing).
 */

export type ConfirmInput = { reason: string; requestKey: string; code?: string }

const REASON_MIN = 10
const CODE = /^\d{6}$/

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60'

export const PRIMARY_BUTTON = cn(BUTTON, 'bg-primary text-primary-foreground hover:bg-primary/90')
export const QUIET_BUTTON = cn(
  BUTTON,
  'border border-border bg-background text-foreground hover:bg-muted',
)
export const DANGER_BUTTON = cn(
  BUTTON,
  'border border-tone-danger-foreground/40 bg-background text-tone-danger-foreground hover:bg-tone-danger',
)

export function ConfirmAction({
  trigger,
  triggerClassName = PRIMARY_BUTTON,
  title,
  body,
  confirmLabel,
  destructive = false,
  needsCode = false,
  children,
  canConfirm = true,
  run,
  successMessage,
}: {
  trigger: React.ReactNode
  triggerClassName?: string
  title: string
  body: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  needsCode?: boolean
  /** More fields the action needs (caps), shown above the reason. */
  children?: React.ReactNode
  canConfirm?: boolean
  run: (input: ConfirmInput) => Promise<AdminResult>
  successMessage: string
}) {
  const router = useRouter()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [requestKey, setRequestKey] = useState('')
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function onOpenChange(next: boolean) {
    if (pending) return
    setOpen(next)
    if (next) {
      setRequestKey(crypto.randomUUID())
      setReason('')
      setCode('')
      setError(null)
      setDone(null)
    }
  }

  const trimmed = reason.trim()
  const ready =
    canConfirm &&
    trimmed.length >= REASON_MIN &&
    trimmed.length <= 500 &&
    (!needsCode || CODE.test(code)) &&
    !pending &&
    !done

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    setPending(true)
    setError(null)
    try {
      const result = await run({ reason: trimmed, requestKey, ...(needsCode ? { code } : {}) })
      if (result.ok) {
        setDone(
          result.replayed ? `${successMessage} (It had already gone through.)` : successMessage,
        )
        router.refresh()
      } else {
        setError(result.message)
        if (result.code !== UNKNOWN_OUTCOME) setRequestKey(crypto.randomUUID())
      }
    } catch {
      setError(LOST_ANSWER_WORDS)
    } finally {
      // A code works once: the next try needs the next one.
      setCode('')
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div id={`${id}-body`} className="space-y-2 text-pretty">
              {body}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={submit} className="grid gap-4" aria-describedby={`${id}-body`}>
          {children && !done ? <div className="grid gap-4">{children}</div> : null}
          {done ? null : (
            <div>
              <label htmlFor={`${id}-reason`} className="text-sm font-medium text-foreground">
                Reason
              </label>
              <textarea
                id={`${id}-reason`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={3}
                required
                disabled={pending}
                aria-describedby={`${id}-reason-hint`}
                className={cn(inputClass, 'mt-1.5 h-auto min-h-24 py-2.5')}
              />
              <p id={`${id}-reason-hint`} className="mt-1.5 text-xs text-muted-foreground">
                At least {REASON_MIN} characters. Don't include personal details: it is kept in the
                audit log.
              </p>
            </div>
          )}
          {needsCode && !done ? (
            <div>
              <label htmlFor={`${id}-code`} className="text-sm font-medium text-foreground">
                Code from your authenticator app
              </label>
              <input
                id={`${id}-code`}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                disabled={pending}
                className={cn(inputClass, 'mt-1.5 w-40 font-mono tracking-widest tabular-nums')}
              />
            </div>
          ) : null}
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          {done ? <FormMessage tone="success">{done}</FormMessage> : null}
          <AlertDialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={pending}
              className={QUIET_BUTTON}
            >
              {done ? 'Close' : 'Cancel'}
            </button>
            {done ? null : (
              <button
                type="submit"
                disabled={!ready}
                aria-busy={pending || undefined}
                className={destructive ? DANGER_BUTTON : PRIMARY_BUTTON}
              >
                {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
                {confirmLabel}
              </button>
            )}
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
