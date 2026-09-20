'use client'

import { ArrowRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { parseSearchQuery, searchHref } from '../lib/query'

/**
 * Hero search (PRD FR-S1). One pill: a quiet label, the input, and the CTA.
 *
 * Validation is deliberately gentle — it only speaks up after a submit attempt,
 * so nobody is told they are wrong while still typing.
 */
export function DomainSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter()
  const inputId = useId()
  const errorId = useId()

  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  /**
   * Until React has hydrated, a submit is handled natively by the form's
   * `action`/`method` below — the query reaches /search unnormalised, which the
   * search page tolerates. This marker lets tests wait for the enhanced path
   * rather than racing it.
   */
  const [isEnhanced, setIsEnhanced] = useState(false)
  useEffect(() => setIsEnhanced(true), [])

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = parseSearchQuery(value)

    if (!parsed.isValid) {
      setError(
        value.trim()
          ? 'Use letters, numbers and hyphens — for example getpaid.ng'
          : 'Type a name to search for',
      )
      return
    }

    setError(null)
    router.push(searchHref(value))
  }

  return (
    /**
     * Progressive enhancement: `action` and `method` mean a submit before
     * hydration — or with JS disabled — still reaches the search page with the
     * query intact. The handler below enhances that with normalisation and
     * inline validation once React has taken over.
     */
    <form
      action="/search"
      method="get"
      onSubmit={onSubmit}
      noValidate
      data-enhanced={isEnhanced ? 'true' : undefined}
      className="w-full"
    >
      <div className="flex flex-col gap-2 rounded-3xl bg-background p-2 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.25)] sm:flex-row sm:items-center sm:gap-3 sm:rounded-full sm:p-2 sm:pl-7">
        <div className="min-w-0 flex-1 px-4 pt-3 sm:px-0 sm:pt-0">
          <label htmlFor={inputId} className="block text-xs text-muted-foreground">
            Find your domain
          </label>
          <input
            id={inputId}
            name="q"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: opt-in only, used on the search page where the field is the page's purpose
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              if (error) setError(null)
            }}
            placeholder="yourbrand.ng"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="w-full bg-transparent py-1 text-base text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        <Button
          type="submit"
          size="lg"
          className="h-14 shrink-0 rounded-2xl bg-accent px-8 text-base font-medium text-accent-foreground hover:bg-accent/90 sm:rounded-full"
        >
          Search
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <p
        id={errorId}
        role={error ? 'alert' : undefined}
        hidden={!error}
        className="mt-2 pl-2 text-sm text-destructive sm:pl-7"
      >
        {error}
      </p>
    </form>
  )
}
