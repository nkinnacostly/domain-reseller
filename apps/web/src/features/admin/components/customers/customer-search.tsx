'use client'

import { Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { Spinner } from '@/components/ui/spinner'
import { findCustomers } from '@/features/admin/actions/customers'
import { EmptyState } from '@/features/admin/components/empty-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import {
  SEARCH_COUNTS,
  SEARCH_FAILED,
  SEARCH_FOUND,
  SEARCH_HINT,
  SEARCH_LABEL,
  SEARCH_NO_MATCH,
  SEARCH_NO_MATCH_BODY,
  SEARCH_ROLE,
  SEARCH_TEST_ADMIN,
  SEARCH_TOO_SHORT,
} from '@/features/admin/lib/customers-copy'
import type { FoundCustomer } from '@/features/admin/lib/customers-data'
import { adminOutcome, UNKNOWN_OUTCOME } from '@/features/admin/lib/errors'
import { formatCount } from '@/features/admin/lib/format'
import { cn } from '@/lib/utils'
import { AccountLink, MaskedEmail, When } from './parts'

/**
 * Finding a customer by exact email, order number or domain (§5.2 B8): a
 * POST to `findCustomers`, never `?q=` (N13, §1). The form posts no field
 * of its own — the box has no name — and its button waits for the page to
 * hydrate, so an email can't be sent before the action is ready, nor land in
 * the address. What was typed and found lives here only, and is forgotten
 * when the page is left (Next keeps a left page in the DOM).
 */
export function CustomerSearch({ testOnly, canSearch }: { testOnly: boolean; canSearch: boolean }) {
  if (!canSearch) return <p className="text-sm text-muted-foreground">{SEARCH_ROLE}</p>
  return <SearchForm testOnly={testOnly} />
}

const FOUND_COLUMNS: Column<FoundCustomer>[] = [
  { key: 'account', header: 'Customer', cell: (row) => <AccountLink userId={row.userId} /> },
  { key: 'email', header: 'Email', cell: (row) => <MaskedEmail value={row.maskedEmail} /> },
  { key: 'joined', header: 'Joined', cell: (row) => <When at={row.joinedAt} /> },
  {
    key: 'domains',
    header: 'Domains held',
    numeric: true,
    cell: (row) => formatCount(row.domainsHeld),
  },
  {
    key: 'orders',
    header: 'Orders paid',
    numeric: true,
    cell: (row) => formatCount(row.ordersPaid),
  },
]

function SearchForm({ testOnly }: { testOnly: boolean }) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [enhanced, setEnhanced] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [found, setFound] = useState<FoundCustomer[] | null>(null)

  useEffect(() => {
    setEnhanced(true)
    const input = inputRef.current
    // Hidden or left: forget the search, as the page would on a reload.
    return () => {
      setFound(null)
      setError(null)
      if (input) input.value = ''
    }
  }, [])

  function clear() {
    setFound(null)
    setError(null)
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.focus()
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const query = inputRef.current?.value.trim() ?? ''
    if (query.length < 3) {
      setFound(null)
      setError(SEARCH_TOO_SHORT)
      return
    }
    setPending(true)
    setError(null)
    try {
      const outcome = adminOutcome(await findCustomers({ query }))
      if (outcome.ok) {
        setFound(outcome.data ?? [])
      } else {
        setFound(null)
        setError(outcome.code === UNKNOWN_OUTCOME ? SEARCH_FAILED : outcome.message)
      }
    } catch {
      setFound(null)
      setError(SEARCH_FAILED)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <search>
        <form
          method="post"
          aria-label="Find a customer"
          data-enhanced={enhanced ? 'true' : undefined}
          onSubmit={submit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 lg:max-w-md">
            <label htmlFor={`${id}-q`} className="text-sm font-medium text-foreground">
              {SEARCH_LABEL}
            </label>
            <div className="mt-1.5 flex h-11 items-center gap-2.5 rounded-full border border-input bg-background px-4 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={inputRef}
                id={`${id}-q`}
                type="search"
                required
                minLength={3}
                maxLength={254}
                autoComplete="off"
                spellCheck={false}
                placeholder="name@example.com, ND-001035 or example.com"
                aria-describedby={`${id}-hint`}
                disabled={pending}
                className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:opacity-60 sm:text-sm"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!enhanced || pending}
              aria-busy={pending || undefined}
              className={cn(
                'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
                FOCUS,
              )}
            >
              {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
              Search
            </button>
            {found !== null || error ? (
              <button type="button" onClick={clear} className={QUIET_BUTTON}>
                Clear
              </button>
            ) : null}
          </div>
        </form>
        <p id={`${id}-hint`} className="mt-2 max-w-2xl text-xs text-muted-foreground">
          {SEARCH_HINT}
          {testOnly ? ` ${SEARCH_TEST_ADMIN}` : ''}
        </p>
      </search>

      <div aria-live="polite" className="space-y-3">
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        {found !== null && found.length === 0 ? (
          <EmptyState title={SEARCH_NO_MATCH} body={SEARCH_NO_MATCH_BODY} />
        ) : null}
        {found !== null && found.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{SEARCH_FOUND(found.length)}.</span>{' '}
              {SEARCH_COUNTS(testOnly)}
            </p>
            <DataTable<FoundCustomer>
              caption="Customers found"
              rows={found}
              columns={FOUND_COLUMNS}
              rowKey={(row) => row.userId}
              empty={null}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
