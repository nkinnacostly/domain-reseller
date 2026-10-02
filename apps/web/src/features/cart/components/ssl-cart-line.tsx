'use client'

import { CircleAlert, Clock, ShieldCheck, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { removeSslCartLine } from '../actions/ssl'
import { announceCartCount } from '../lib/count'
import type { SslLineView } from '../lib/view'

/** One SSL certificate in the cart (FR-SSL-6): its name in large type, its term and what buying again costs (N8). */
export function SslCartLine({ line }: { line: SslLineView }) {
  const id = useId()
  const router = useRouter()
  const remove = useAction(removeSslCartLine, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) announceCartCount(data.count)
      router.refresh()
    },
  })
  const error =
    remove.result.data && 'error' in remove.result.data ? remove.result.data.error : null
  const unavailable = line.status === 'unavailable'

  return (
    <li
      aria-labelledby={`${id}-name`}
      aria-busy={remove.isPending || undefined}
      data-status={line.status}
      data-certificate={line.name}
      className="py-6 first:pt-0"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            SSL certificate
          </p>
          <h2
            id={`${id}-name`}
            className="mt-1 text-lg font-semibold break-all text-foreground sm:text-xl"
          >
            {line.name}
          </h2>
          <p className="mt-1 text-sm text-foreground">{line.productName}</p>
          <p className="mt-0.5 text-pretty text-sm text-muted-foreground">{line.covers}</p>
          {line.status === 'held' && line.heldUntil ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" aria-hidden="true" />
              Price held until {line.heldUntil}
            </p>
          ) : null}
          {line.status === 'changed' ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
              <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
              Price changed: was {line.was}, now {line.total}
            </p>
          ) : null}
          {unavailable ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
              <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
              We no longer sell this certificate. Remove it to continue.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => remove.execute({ lineId: line.id })}
          disabled={remove.isPending}
          aria-label={`Remove the certificate for ${line.name}`}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring active:scale-95 disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      {unavailable ? null : (
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <p className="max-w-md text-pretty text-xs/5 text-muted-foreground">
            You install it on your own server or hosting. {line.renewal}
          </p>
          <div className="sm:text-right">
            <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
              {line.total}
            </p>
            <p className="text-sm text-muted-foreground">{line.term}</p>
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}
