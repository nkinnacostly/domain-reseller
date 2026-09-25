'use client'

import { RotateCw, ShieldCheck } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { useId, useRef, useState } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { hasTurnstile, Turnstile, type TurnstileHandle } from '@/components/common/turnstile'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { confirmHuman } from '../actions/human'

const DID_NOT_LOAD =
  "The check didn't load. If something on this device blocks challenges.cloudflare.com, allow it and try again — or wait a few minutes."

/**
 * The Turnstile check that earns a search pass (SEC-9): shown in place of
 * results past the free allowance, and before a bulk search starts. The token
 * goes straight to the server, which sets the pass; the page then carries on
 * — a results page is re-rendered by the action itself, bulk search is told
 * through `onPassed`.
 *
 * Usually nothing to do: the widget appears only if Cloudflare wants a click.
 * A refusal or a widget that never loaded says so, with a way to try again.
 */
export function HumanCheck({
  title,
  children,
  action,
  onPassed,
  className,
}: {
  title: string
  /** Why the check is here, in a sentence. */
  children: React.ReactNode
  /** Names the place in Cloudflare's analytics. */
  action: string
  onPassed?: () => void
  className?: string
}) {
  const id = useId()
  const widget = useRef<TurnstileHandle>(null)
  const [didNotLoad, setDidNotLoad] = useState(false)
  const confirm = useAction(confirmHuman, {
    onSuccess: ({ data }) => {
      if (data && 'passed' in data) onPassed?.()
    },
  })
  const answer = confirm.result.data
  const refused =
    answer && 'error' in answer
      ? answer.error
      : (confirm.result.serverError ??
        (confirm.result.validationErrors
          ? "We couldn't confirm you're a person. Try again."
          : null))
  const problem = didNotLoad ? DID_NOT_LOAD : refused

  function tryAgain() {
    setDidNotLoad(false)
    confirm.reset()
    widget.current?.reset()
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        'rounded-3xl border border-border bg-background p-5 text-foreground sm:p-6',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand-ink">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="font-semibold text-balance text-foreground">
            {title}
          </h2>
          <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">{children}</p>
        </div>
      </div>

      {hasTurnstile() ? (
        <>
          <Turnstile
            ref={widget}
            action={action}
            onToken={(token) => {
              setDidNotLoad(false)
              confirm.execute({ token })
            }}
            onError={() => setDidNotLoad(true)}
            className="mt-4"
          />
          {problem ? (
            <div className="mt-4 space-y-3">
              <FormMessage tone="error">{problem}</FormMessage>
              <button
                type="button"
                onClick={tryAgain}
                className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
              >
                <RotateCw className="size-4" aria-hidden="true" />
                Try again
              </button>
            </div>
          ) : (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" aria-hidden="true" />
              {confirm.isPending ? 'Confirming…' : 'Checking you’re a person…'}
            </p>
          )}
        </>
      ) : (
        // A build without a site key has no check to offer (the server should
        // not have asked for one): waiting is the honest answer.
        <p className="mt-4 text-pretty text-sm/6 text-foreground">
          Wait a few minutes, then try again.
        </p>
      )}
    </section>
  )
}
