'use client'

import { ListChecks } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BULK_MAX_NAMES, bulkHref, splitNames } from '../lib/bulk'
import { toUnicodeHost } from '../lib/idn'

/**
 * Bulk search (PRD FR-S5): a list of names, one per line, and the extensions
 * to try names typed without one on.
 *
 * Like the hero search, `action`/`method` make it work before hydration and
 * with JS off — the page reads `?names=` and `?tld=` either way — and once
 * React has taken over, a submit is checked here first so nobody waits on
 * the server to be told the list is empty or too long. The field is
 * uncontrolled on purpose (see DomainSearch).
 */
export function BulkSearchForm({
  extensions,
  defaultNames = '',
  defaultPicked,
}: {
  /** Extensions offered for names without one, lead first. */
  extensions: readonly string[]
  defaultNames?: string
  /** Ticked when the page opens: the ones last searched, else the lead one. */
  defaultPicked: readonly string[]
}) {
  const router = useRouter()
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isEnhanced, setIsEnhanced] = useState(false)
  useEffect(() => setIsEnhanced(true), [])

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const names = splitNames(String(form.get('names') ?? ''))
    const tlds = form.getAll('tld').map(String)

    if (names.length === 0) {
      setError('Type or paste at least one name.')
      return
    }
    if (new Set(names).size > BULK_MAX_NAMES) {
      setError(
        `That's ${new Set(names).size} names. Bulk search checks up to ${BULK_MAX_NAMES} at a time — remove some, or check them in two goes.`,
      )
      return
    }

    setError(null)
    startTransition(() => router.push(bulkHref(names, tlds)))
  }

  return (
    <form
      action="/search/bulk"
      method="get"
      onSubmit={onSubmit}
      noValidate
      aria-label="Bulk search"
      data-enhanced={isEnhanced ? 'true' : undefined}
      className="w-full rounded-3xl bg-background p-4 text-foreground shadow-[0_18px_40px_-18px_rgb(0_0_0/0.25)] sm:p-6"
    >
      <label htmlFor={`${id}-names`} className="block text-sm font-medium text-foreground">
        Names to check
      </label>
      <p id={`${id}-hint`} className="mt-1 text-pretty text-xs/5 text-muted-foreground">
        One per line, up to {BULK_MAX_NAMES}. With an extension (getpaid.com) or without (getpaid).
        Names in any script work, like café.com.
      </p>
      <textarea
        id={`${id}-names`}
        name="names"
        rows={7}
        defaultValue={defaultNames}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={'getpaid\nmybrand.africa\ncafé.com'}
        onChange={() => {
          if (error) setError(null)
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        className="mt-3 block w-full resize-y rounded-2xl border border-input bg-background px-3.5 py-3 font-mono text-base text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
      />

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-foreground">
          Check names without an extension on
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {extensions.map((tld) => (
            <label
              key={tld}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition hover:bg-muted has-checked:border-accent/50 has-checked:bg-accent/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
            >
              <input
                type="checkbox"
                name="tld"
                value={tld}
                defaultChecked={defaultPicked.includes(tld)}
                className="size-4 accent-accent"
              />
              .{toUnicodeHost(tld)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          aria-busy={isPending || undefined}
          className="h-12 shrink-0 rounded-full bg-accent px-7 text-base font-medium text-accent-foreground hover:bg-accent/90 active:scale-[0.98]"
        >
          {isPending ? (
            <>
              <Spinner className="size-4" aria-hidden="true" />
              Checking…
            </>
          ) : (
            <>
              <ListChecks className="size-4" aria-hidden="true" />
              Check names
            </>
          )}
        </Button>
        <p
          id={`${id}-error`}
          role={error ? 'alert' : undefined}
          hidden={!error}
          className="text-pretty text-sm font-medium text-destructive"
        >
          {error}
        </p>
      </div>
    </form>
  )
}
