'use client'

import { Sparkle } from 'lucide-react'
import Link from 'next/link'
import { useId, useState, useTransition } from 'react'
import {
  describedBy,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import { findNameIdeas } from '../actions/name-ideas'
import { DESCRIPTION_MAX, DESCRIPTION_MIN, type NameIdeasResult } from '../lib/name-ideas'
import { ResultItem } from './result-list'

const REFUSAL: Record<Exclude<NameIdeasResult, { ok: true }>['reason'], string> = {
  off: 'The name finder isn’t switched on yet. Search for a name you have in mind instead.',
  limited: 'You’ve asked for a lot of ideas in a few minutes. Wait a little, then try again.',
  busy: 'The registry is busy right now. Try again in a minute.',
  unavailable: 'We couldn’t get ideas just now. Try again, or search for a name you have in mind.',
}

/**
 * The AI name finder (feature 1): a sentence about a business, an extension,
 * and back come names that are free to register, each with its first-year
 * and renewal price (N8) and the reason it was suggested. The model only
 * proposes; every name shown was checked with the registry.
 *
 * The note under the box says where the description goes (N9b, NDPA): to
 * DeepSeek, with email addresses and phone numbers taken out first.
 */
export function NameFinder({ extensions }: { extensions: readonly string[] }) {
  const id = useId()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<NameIdeasResult | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [tld, setTld] = useState(extensions[0] ?? 'com')

  const submit = onSubmitWith((form) => {
    const description = String(form.get('description') ?? '').trim()
    if (description.length < DESCRIPTION_MIN) {
      setError('Describe your business in a sentence — at least a few words.')
      return
    }
    setError(undefined)
    const picked = String(form.get('tld') ?? tld)
    startTransition(async () => {
      const answer = await findNameIdeas({ description, tld: picked })
      setResult(answer?.data ?? { ok: false, reason: 'unavailable' })
    })
  })

  return (
    <div className="space-y-6">
      <form onSubmit={submit} aria-label="Name finder" className="space-y-4" noValidate>
        <div>
          <label htmlFor={`${id}-description`} className="text-sm font-medium text-foreground">
            Describe your business
          </label>
          <textarea
            id={`${id}-description`}
            name="description"
            rows={3}
            maxLength={DESCRIPTION_MAX}
            placeholder="A bakery in Ibadan that delivers fresh bread and cakes"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(`${id}-description`, error, 'hint')}
            className={cn(inputClass, 'mt-1.5 h-auto min-h-24 py-3')}
          />
          {error ? (
            <p id={`${id}-description-error`} className="mt-1.5 text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p id={`${id}-description-hint`} className="mt-1.5 text-xs text-muted-foreground">
              Sent to DeepSeek, an AI provider, to suggest names; email addresses and phone numbers
              are taken out first. Leave out anything personal.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <label htmlFor={`${id}-tld`} className="text-sm font-medium text-foreground">
              Extension
            </label>
            <select
              id={`${id}-tld`}
              name="tld"
              value={tld}
              onChange={(event) => setTld(event.target.value)}
              className={cn(inputClass, 'mt-1.5')}
            >
              {extensions.map((extension) => (
                <option key={extension} value={extension}>
                  .{extension}
                </option>
              ))}
            </select>
          </div>
          <SubmitButton pending={pending} pendingLabel="Finding names…" className="sm:w-auto">
            <Sparkle className="size-4" aria-hidden="true" />
            Find names
          </SubmitButton>
        </div>
      </form>

      <section aria-label="Name ideas" aria-live="polite" aria-busy={pending || undefined}>
        {pending ? <IdeasSkeleton /> : result ? <IdeasAnswer result={result} /> : null}
      </section>
    </div>
  )
}

function IdeasAnswer({ result }: { result: NameIdeasResult }) {
  if (!result.ok) {
    return (
      <FormMessage tone="error">
        {REFUSAL[result.reason]}{' '}
        <Link href="/search" className="font-medium underline underline-offset-2">
          Search for a domain
        </Link>
      </FormMessage>
    )
  }
  if (result.ideas.length === 0) {
    return (
      <div className="rounded-2xl border border-border border-dashed px-6 py-10 text-center">
        <p className="font-medium text-foreground">
          {result.checked > 0
            ? `All ${result.checked} names we thought of are taken.`
            : 'We couldn’t think of names for that.'}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Describe it another way, or try another extension.
        </p>
      </div>
    )
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        {result.ideas.length} of {result.checked} names are free to register. Each was checked with
        the registry just now.
      </p>
      <ul
        aria-label="Available names"
        className="divide-y divide-border/70 rounded-2xl border border-border bg-background"
      >
        {result.ideas.map(({ row, why }) => (
          <ResultItem key={row.domain} row={row} note={why} />
        ))}
      </ul>
    </div>
  )
}

function IdeasSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-16 animate-pulse rounded-2xl bg-muted/70" />
      ))}
    </div>
  )
}
