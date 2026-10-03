'use client'

import type { AdminLedgerPage } from '@dr/shared/admin'
import { Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { searchLiveLedger } from '@/features/admin/actions/supplier-live'
import { adminOutcome } from '@/features/admin/lib/errors'
import { formatUsd, formatWat } from '@/features/admin/lib/format'
import { LIVE_LEDGER } from '@/features/admin/lib/supplier-copy'
import { formatDelta, kindLabel } from '@/features/admin/lib/supplier-ledger'
import { cn } from '@/lib/utils'

const TAKE = 25

type Query = { from?: string; to?: string; q?: string; trace?: string }

/**
 * "Search the live ledger" (docs/ADMIN-SPEC.md §5.2 B6): DomainNameAPI's own
 * statement, read now through the gateway — a POST, so what is searched for
 * never sits in the page's address, history or logs. Each search writes an
 * audit note first (D22). The fields have no `name` and are read when the
 * search is sent, so a search pressed before the page hydrated submits
 * nothing to the address, and autofill is kept (CLAUDE.md §15).
 */
export function LiveLedgerSearch() {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState<Query | null>(null)
  const [skip, setSkip] = useState(0)
  const [page, setPage] = useState<{ data: AdminLedgerPage; auditId: number } | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const fields = {
    q: useRef<HTMLInputElement>(null),
    trace: useRef<HTMLInputElement>(null),
    from: useRef<HTMLInputElement>(null),
    to: useRef<HTMLInputElement>(null),
  }

  async function run(next: Query, at: number) {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome(await searchLiveLedger({ ...next, skip: at, take: TAKE }))
      if (result.ok && result.data) {
        setPage({ data: result.data, auditId: result.auditId })
        setQuery(next)
        setSkip(at)
      } else if (!result.ok) {
        setError(result.message)
      }
    } catch {
      setError("We couldn't reach the dashboard's server. Try again.")
    } finally {
      setPending(false)
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: Query = {}
    for (const key of ['q', 'trace', 'from', 'to'] as const) {
      const value = (fields[key].current?.value ?? '').trim()
      if (value !== '') next[key] = value
    }
    void run(next, 0)
  }

  const total = page?.data.total ?? 0
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{LIVE_LEDGER.intro}</p>
      <form
        onSubmit={submit}
        aria-label={LIVE_LEDGER.heading}
        data-ready={ready ? 'true' : undefined}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <div>
          <label htmlFor={`${id}-q`} className="text-sm font-medium text-foreground">
            Description contains
          </label>
          <input
            id={`${id}-q`}
            ref={fields.q}
            maxLength={120}
            autoComplete="off"
            className={cn(inputClass, 'mt-1.5')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-trace`} className="text-sm font-medium text-foreground">
            Trace id
          </label>
          <input
            id={`${id}-trace`}
            ref={fields.trace}
            autoComplete="off"
            spellCheck={false}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            className={cn(inputClass, 'mt-1.5 font-mono')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-from`} className="text-sm font-medium text-foreground">
            From
          </label>
          <input
            id={`${id}-from`}
            ref={fields.from}
            type="date"
            className={cn(inputClass, 'mt-1.5')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-to`} className="text-sm font-medium text-foreground">
            To
          </label>
          <input id={`${id}-to`} ref={fields.to} type="date" className={cn(inputClass, 'mt-1.5')} />
        </div>
        <div className="sm:col-span-2 xl:col-span-4">
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending || undefined}
            className={QUIET_BUTTON}
          >
            {pending ? (
              <Spinner className="size-4" aria-hidden="true" />
            ) : (
              <Search className="size-4" aria-hidden="true" />
            )}
            {pending ? LIVE_LEDGER.pending : LIVE_LEDGER.button}
          </button>
        </div>
      </form>

      <ActionError message={error} returnTo="/admin/supplier/ledger" />

      {page ? (
        <section aria-label="Live ledger results" className="space-y-3" data-live-ledger>
          <p role="status" className="text-sm text-muted-foreground">
            {total === 0
              ? LIVE_LEDGER.empty
              : `${total} ${total === 1 ? 'entry' : 'entries'} on the ${page.data.side} side; showing ${skip + 1}–${skip + page.data.items.length}.`}{' '}
            Read {formatWat(page.data.readAt)} · audit entry #{page.auditId}
          </p>
          {page.data.items.length > 0 ? (
            <ul className="space-y-2">
              {page.data.items.map((item) => (
                <li
                  key={item.traceId}
                  className="grid gap-1 rounded-2xl border border-border bg-background/70 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="font-medium break-all text-foreground">
                      {item.description || '—'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatWat(item.occurredAt)} · {kindLabel(item)}
                    </p>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {item.traceId}
                    </p>
                  </div>
                  <div className="text-right tabular-nums">
                    <p className="text-foreground">{formatDelta(item.deltaCents)}</p>
                    <p className="text-xs text-muted-foreground">
                      then {formatUsd(item.balanceAfterCents)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {total > TAKE && query ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending || skip === 0}
                onClick={() => run(query, Math.max(0, skip - TAKE))}
                className={QUIET_BUTTON}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={pending || skip + TAKE >= total}
                onClick={() => run(query, skip + TAKE)}
                className={QUIET_BUTTON}
              >
                Next
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
