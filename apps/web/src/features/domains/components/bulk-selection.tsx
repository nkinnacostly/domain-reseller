'use client'

import { createContext, use, useMemo, useState } from 'react'
import { domainLabel } from '@/components/common/domain-name'
import { cn } from '@/lib/utils'

/**
 * FR-P4 — which of the portfolio's domains are ticked. Only what is shown
 * counts: a domain ticked and then filtered out is not acted on, so a bulk
 * change never reaches a domain the person can no longer see.
 */
type Selection = {
  /** The ids shown, in the order shown. */
  shown: readonly string[]
  selected: ReadonlySet<string>
  toggle: (id: string, on: boolean) => void
  setAll: (on: boolean) => void
}

const SelectionContext = createContext<Selection | null>(null)

export function useBulkSelection(): Selection {
  const selection = use(SelectionContext)
  if (!selection) throw new Error('useBulkSelection needs a BulkSelection around it')
  return selection
}

export function BulkSelection({
  ids,
  children,
}: {
  ids: readonly string[]
  children: React.ReactNode
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const value = useMemo<Selection>(() => {
    const selected = new Set(ids.filter((id) => picked.has(id)))
    return {
      shown: ids,
      selected,
      toggle: (id, on) =>
        setPicked((current) => {
          const next = new Set(current)
          if (on) next.add(id)
          else next.delete(id)
          return next
        }),
      setAll: (on) => setPicked(on ? new Set(ids) : new Set()),
    }
  }, [ids, picked])
  return <SelectionContext value={value}>{children}</SelectionContext>
}

/** One domain's tick box: a 44px target (S7), named for the domain it selects. */
export function SelectDomain({
  id,
  name,
  className,
}: {
  id: string
  name: string
  className?: string
}) {
  const { selected, toggle } = useBulkSelection()
  return (
    <label
      className={cn(
        'relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-full transition-colors hover:bg-muted',
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={selected.has(id)}
        onChange={(event) => toggle(id, event.target.checked)}
        className="size-4 cursor-pointer accent-[var(--accent)]"
      />
      <span className="sr-only">Select {domainLabel(name)}</span>
    </label>
  )
}
