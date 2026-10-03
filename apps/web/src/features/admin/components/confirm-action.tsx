'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage, inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type AdminResult, LOST_ANSWER_WORDS, UNKNOWN_OUTCOME } from '@/features/admin/lib/errors'
import { cn } from '@/lib/utils'

/**
 * Every admin action that changes something asks here first (ADMIN-SPEC
 * §5.1). What it asks follows the action: a reason, ticked checks, the name
 * typed back, and for a money action the code from the authenticator app
 * (D6) — verified by the server before anything else.
 *
 * Each opening gets a request key. A refused answer gets a new one; a lost
 * answer (network, timeout) keeps it, so trying again replays a change that
 * went through instead of making it twice.
 */

export type ConfirmCheck = { id: string; label: string }
export type ConfirmRow = { label: string; value: React.ReactNode }

export type ConfirmExtra = {
  reason?: string
  requestKey: string
  checks: Record<string, boolean>
  code?: string
}

const REASON_MIN = 10
const CODE = /^\d{6}$/

const BUTTON =
  'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60'

export function ConfirmAction({
  trigger,
  triggerClassName,
  title,
  rows = [],
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  reason = 'none',
  reasonLabel = 'Reason',
  reasonMax = 500,
  typeToConfirm,
  checks = [],
  destructive = false,
  needsCode = false,
  disabled = false,
  canConfirm = true,
  notReadyHint,
  children,
  run,
  returnTo,
  successMessage = 'Done.',
}: {
  trigger: React.ReactNode
  triggerClassName?: string
  title: string
  rows?: ConfirmRow[]
  body?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  reason?: 'required' | 'optional' | 'none'
  reasonLabel?: string
  reasonMax?: number
  /** Typed back exactly before the button is enabled — the order number, the domain. */
  typeToConfirm?: string
  checks?: ConfirmCheck[]
  destructive?: boolean
  /** A money action: asks for the code from the authenticator app. */
  needsCode?: boolean
  /** The trigger itself: nothing to open. */
  disabled?: boolean
  /**
   * Whatever the dialog's own `children` collect is ready: until it is, the
   * confirm button stays disabled and `notReadyHint` says why.
   */
  canConfirm?: boolean
  notReadyHint?: React.ReactNode
  /**
   * Choices the action needs before it can run — an outcome, a check made
   * from inside the dialog — shown in the dialog's body, after its rows and
   * text. They sit outside the dialog's own form, so they may hold a form.
   */
  children?: React.ReactNode
  run: (extra: ConfirmExtra) => Promise<AdminResult<unknown>>
  /** Where the "Enter a code" link comes back to. */
  returnTo: string
  successMessage?: string
}) {
  const router = useRouter()
  const id = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [requestKey, setRequestKey] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [typed, setTyped] = useState('')
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function onOpenChange(next: boolean) {
    if (pending) return
    setOpen(next)
    if (next) {
      setRequestKey(crypto.randomUUID())
      setReasonText('')
      setTyped('')
      setTicked({})
      setCode('')
      setError(null)
      setDone(null)
    }
  }

  const trimmed = reasonText.trim()
  const reasonOk =
    reason === 'required'
      ? trimmed.length >= REASON_MIN && trimmed.length <= reasonMax
      : trimmed.length <= reasonMax
  const typedOk = typeToConfirm === undefined || typed.trim() === typeToConfirm
  const checksOk = checks.every((check) => ticked[check.id])
  const codeOk = !needsCode || CODE.test(code)
  const ready = canConfirm && reasonOk && typedOk && checksOk && codeOk && !pending && !done

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    setPending(true)
    setError(null)
    try {
      const result = await run({
        ...(reason !== 'none' && trimmed ? { reason: trimmed } : {}),
        requestKey,
        checks: ticked,
        ...(needsCode ? { code } : {}),
      })
      if (result.ok) {
        const words = result.replayed
          ? `${successMessage} (It had already gone through.)`
          : successMessage
        setDone(words)
        toast.success(words)
        router.refresh()
      } else {
        setError(result.message)
        // A refused answer is final for this key; one we could not read is not.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            destructive
              ? QUIET_BUTTON
              : cn(BUTTON, 'bg-brand text-brand-foreground hover:bg-brand/90', FOCUS),
            triggerClassName,
          )}
        >
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          if (!destructive) return
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <div className="grid gap-4">
          <DialogTitle className="pr-8 text-lg font-medium">{title}</DialogTitle>
          <DialogDescription asChild>
            <div id={`${id}-body`} className="space-y-3 text-sm text-muted-foreground">
              {rows.length > 0 ? (
                <dl className="grid gap-2 rounded-xl border border-border p-3 text-sm">
                  {rows.map((row) => (
                    <div key={row.label} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 break-words text-right text-foreground">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {body ? <div className="text-pretty">{body}</div> : null}
            </div>
          </DialogDescription>

          {children && !done ? <div className="space-y-4">{children}</div> : null}

          <form onSubmit={submit} className="grid gap-4" aria-describedby={`${id}-body`}>
            {checks.map((check) => (
              <label
                key={check.id}
                className="flex min-h-11 items-start gap-3 text-sm text-foreground"
              >
                <input
                  type="checkbox"
                  checked={Boolean(ticked[check.id])}
                  onChange={(event) =>
                    setTicked((current) => ({ ...current, [check.id]: event.target.checked }))
                  }
                  disabled={pending || Boolean(done)}
                  className="mt-0.5 size-5 shrink-0 accent-brand"
                />
                <span>{check.label}</span>
              </label>
            ))}

            {reason !== 'none' ? (
              <div>
                <label htmlFor={`${id}-reason`} className="text-sm font-medium text-foreground">
                  {reasonLabel}
                  {reason === 'optional' ? ' (optional)' : ''}
                </label>
                <Textarea
                  id={`${id}-reason`}
                  value={reasonText}
                  onChange={(event) => setReasonText(event.target.value)}
                  maxLength={reasonMax}
                  rows={3}
                  required={reason === 'required'}
                  disabled={pending || Boolean(done)}
                  aria-describedby={`${id}-reason-hint`}
                  className="mt-1.5"
                />
                <p id={`${id}-reason-hint`} className="mt-1.5 text-xs text-muted-foreground">
                  Don't include personal details.
                  {reason === 'required' ? ` At least ${REASON_MIN} characters.` : ''} It is kept in
                  the audit log.
                </p>
              </div>
            ) : null}

            {typeToConfirm !== undefined ? (
              <div>
                <label htmlFor={`${id}-typed`} className="text-sm font-medium text-foreground">
                  Type <span className="font-mono break-all">{typeToConfirm}</span> to confirm
                </label>
                <input
                  id={`${id}-typed`}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending || Boolean(done)}
                  className={cn(inputClass, 'mt-1.5 font-mono')}
                />
              </div>
            ) : null}

            {needsCode ? (
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
                  disabled={pending || Boolean(done)}
                  className={cn(inputClass, 'mt-1.5 w-40 font-mono tracking-widest tabular-nums')}
                />
              </div>
            ) : null}

            {!canConfirm && notReadyHint && !done ? (
              <p className="text-xs text-muted-foreground">{notReadyHint}</p>
            ) : null}
            <ActionError message={error} returnTo={returnTo} />
            {done ? <FormMessage tone="success">{done}</FormMessage> : null}

            <DialogFooter className="gap-2 sm:gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={pending}
                className={QUIET_BUTTON}
              >
                {done ? 'Close' : cancelLabel}
              </button>
              {done ? null : (
                <button
                  type="submit"
                  disabled={!ready}
                  aria-busy={pending || undefined}
                  className={cn(
                    BUTTON,
                    destructive
                      ? 'border border-destructive/50 bg-destructive/10 text-foreground hover:bg-destructive/20'
                      : 'bg-brand text-brand-foreground hover:bg-brand/90',
                    FOCUS,
                  )}
                >
                  {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
                  {confirmLabel}
                </button>
              )}
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
