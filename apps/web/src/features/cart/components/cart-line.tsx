'use client'

import { CircleAlert, Clock, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { DomainName, domainLabel } from '@/components/common/domain-name'
import { Switch } from '@/components/ui/switch'
import { removeCartLine, updateCartLine } from '../actions/cart'
import { announceCartCount } from '../lib/count'
import type { LineView } from '../lib/view'

export function CartLine({ line }: { line: LineView }) {
  const id = useId()
  const router = useRouter()
  const update = useAction(updateCartLine, { onSuccess: () => router.refresh() })
  const remove = useAction(removeCartLine, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) announceCartCount(data.count)
      router.refresh()
    },
  })
  const busy = update.isPending || remove.isPending
  const error =
    (update.result.data && 'error' in update.result.data ? update.result.data.error : null) ??
    (remove.result.data && 'error' in remove.result.data ? remove.result.data.error : null)
  const unavailable = line.status === 'unavailable'

  return (
    <li
      aria-labelledby={`${id}-domain`}
      aria-busy={busy || undefined}
      data-status={line.status}
      className="py-6 first:pt-0"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id={`${id}-domain`}
            className="text-lg font-semibold break-all text-foreground sm:text-xl"
          >
            <DomainName name={line.domain} />
          </h2>
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
              We no longer sell .{line.tld}. Remove it to continue.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => remove.execute({ lineId: line.id })}
          disabled={busy}
          aria-label={`Remove ${domainLabel(line.domain)}`}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring active:scale-95 disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      {unavailable ? null : (
        <div className="mt-4 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-4">
            <div>
              <label htmlFor={`${id}-period`} className="text-sm font-medium text-foreground">
                Registration period
              </label>
              <select
                id={`${id}-period`}
                value={line.periodYears}
                disabled={busy || line.periodOptions.length < 2}
                onChange={(event) =>
                  update.execute({ lineId: line.id, periodYears: Number(event.target.value) })
                }
                className="mt-1.5 block h-11 w-full max-w-xs rounded-xl border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 sm:text-sm"
              >
                {line.periodOptions.map((option) => (
                  <option key={option.years} value={option.years}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="flex cursor-pointer items-start gap-3" htmlFor={`${id}-renew`}>
                <Switch
                  id={`${id}-renew`}
                  checked={line.autoRenew}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    update.execute({ lineId: line.id, autoRenew: checked })
                  }
                  aria-labelledby={`${id}-renew-label`}
                  aria-describedby={`${id}-renew-note`}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span id={`${id}-renew-label`} className="font-medium text-foreground">
                    Renew automatically
                  </span>
                  <span id={`${id}-renew-note`} className="block text-muted-foreground">
                    At {line.renewal}/yr. Automatic renewal isn’t switched on yet — this records
                    what you want, and you renew from your account.
                  </span>
                </span>
              </label>

              {line.privacyOffered ? (
                <label className="flex cursor-pointer items-start gap-3" htmlFor={`${id}-privacy`}>
                  <Switch
                    id={`${id}-privacy`}
                    checked={line.privacy}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      update.execute({ lineId: line.id, privacy: checked })
                    }
                    aria-labelledby={`${id}-privacy-label`}
                    aria-describedby={`${id}-privacy-note`}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    <span id={`${id}-privacy-label`} className="font-medium text-foreground">
                      Contact privacy
                    </span>
                    <span id={`${id}-privacy-note`} className="block text-muted-foreground">
                      Keeps your name, email and phone out of public lookups. Free.
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          </div>

          <div className="sm:text-right">
            <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
              {line.total}
            </p>
            <p className="text-sm text-muted-foreground">
              for {line.periodYears} {line.periodYears === 1 ? 'year' : 'years'}, then{' '}
              {line.renewal}/yr
            </p>
            {line.includesIcannFee ? (
              <p className="mt-1 text-xs text-muted-foreground">Includes the ICANN fee</p>
            ) : null}
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
