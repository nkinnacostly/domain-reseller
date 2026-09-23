'use client'

import { ArrowRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { parseTransferQuery, TRANSFER_QUERY_MESSAGES, transferCheckHref } from '../lib/href'

/**
 * Transfer eligibility check (PRD FR-T1). Same pill as the hero search so the
 * two read as one product.
 *
 * `action`/`method` keep it working before hydration and with JS off — the
 * page reads `?domain=` either way. Once React takes over, the submit is
 * normalised, validated inline, and the button shows the lookup is running:
 * a registry can take a second or two to answer, and a button that does
 * nothing for that long invites a second press (S12).
 */
export function TransferCheckForm() {
  const router = useRouter()
  const inputId = useId()
  const errorId = useId()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const [isEnhanced, setIsEnhanced] = useState(false)
  useEffect(() => setIsEnhanced(true), [])

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // FormData, not React state — autofill sets the field without onChange.
    const submitted = String(new FormData(event.currentTarget).get('domain') ?? '')
    const query = parseTransferQuery(submitted)

    if (!query.ok) {
      setError(TRANSFER_QUERY_MESSAGES[query.reason])
      return
    }

    setError(null)
    startTransition(() => router.push(transferCheckHref(query.domain)))
  }

  return (
    <form
      action="/transfer"
      method="get"
      onSubmit={onSubmit}
      noValidate
      aria-label="Transfer check"
      data-enhanced={isEnhanced ? 'true' : undefined}
      className="w-full"
    >
      <div className="flex flex-col gap-2 rounded-3xl bg-background p-2 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.25)] sm:flex-row sm:items-center sm:gap-3 sm:rounded-full sm:p-2 sm:pl-7">
        <div className="min-w-0 flex-1 px-4 pt-3 sm:px-0 sm:pt-0">
          <label htmlFor={inputId} className="block text-xs text-muted-foreground">
            Domain to transfer
          </label>
          <input
            id={inputId}
            name="domain"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // Uncontrolled on purpose — see DomainSearch.
            onChange={() => {
              if (error) setError(null)
            }}
            placeholder="yourbrand.com"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="w-full bg-transparent py-1 text-base text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          aria-busy={isPending || undefined}
          className="h-14 shrink-0 rounded-2xl bg-accent px-8 text-base font-medium text-accent-foreground hover:bg-accent/90 sm:rounded-full"
        >
          {isPending ? (
            <>
              <Spinner className="size-4" aria-hidden="true" />
              Checking…
            </>
          ) : (
            <>
              Check domain
              <ArrowRight className="size-4" aria-hidden="true" />
            </>
          )}
        </Button>
      </div>

      <p
        id={errorId}
        role={error ? 'alert' : undefined}
        hidden={!error}
        // It sits on the blue hero: red straight on blue would fail contrast.
        className="mt-2 w-fit rounded-full bg-background px-4 py-1.5 text-sm font-medium text-destructive"
      >
        {error}
      </p>
    </form>
  )
}
