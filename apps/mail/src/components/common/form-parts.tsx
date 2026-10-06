import { CircleAlert, CircleCheck } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** Inputs sized for thumbs (S7: 44px) and wired to their messages. */
export const inputClass =
  'h-11 w-full rounded-xl border border-input bg-background px-3.5 text-base text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-tone-danger-foreground aria-invalid:ring-tone-danger-foreground/20 disabled:cursor-not-allowed disabled:opacity-60'

/** The formatted-errors shape next-safe-action returns for a field. */
type Formatted = { _errors?: string[] } & Record<string, unknown>

export function fieldError(errors: unknown, field: string): string | undefined {
  const node = (errors as Record<string, Formatted> | undefined)?.[field]
  return node?._errors?.[0]
}

export function Field({
  id,
  label,
  error,
  hint,
  action,
  children,
}: {
  id: string
  /** Text, or markup such as a domain in its own script (FR-S8). */
  label: React.ReactNode
  error?: string | undefined
  hint?: string
  /** A link beside the label, e.g. "Forgot password?". */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {action}
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-tone-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Wires an input to its hint or error for screen readers. */
export function describedBy(id: string, error?: string, hint?: string): string | undefined {
  if (error) return `${id}-error`
  if (hint) return `${id}-hint`
  return undefined
}

export function FormMessage({
  tone,
  children,
  className,
}: {
  tone: 'error' | 'success'
  children: React.ReactNode
  className?: string
}) {
  const Icon = tone === 'error' ? CircleAlert : CircleCheck
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex gap-2.5 rounded-xl px-3.5 py-3 text-sm/6',
        tone === 'error'
          ? 'bg-tone-danger text-tone-danger-foreground'
          : 'bg-tone-success text-tone-success-foreground',
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-pretty">{children}</div>
    </div>
  )
}

/**
 * Pressed, pending and disabled states (S12): a sign-in that shows nothing
 * for two seconds gets pressed twice.
 */
export function SubmitButton({
  pending,
  children,
  pendingLabel,
  variant = 'primary',
  className,
}: {
  pending: boolean
  children: React.ReactNode
  pendingLabel: string
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        'inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
        variant === 'primary'
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-background text-foreground hover:bg-muted',
        className,
      )}
    >
      {pending ? (
        <>
          <Spinner className="size-4" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}

/**
 * Submit handler that reads the form without resetting it.
 *
 * React 19 clears a form after an `action={fn}` submission, which wipes the
 * email field after a wrong password. onSubmit + FormData keeps what the
 * person typed, and still reads values set by autofill without onChange.
 */
export function onSubmitWith(handle: (form: FormData) => void) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    handle(new FormData(event.currentTarget))
  }
}
