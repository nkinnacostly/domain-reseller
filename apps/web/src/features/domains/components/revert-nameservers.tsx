'use client'

import { Undo2 } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { type NameserverDelivery, requestNameservers } from '../actions/domains'
import { ActionError, NeedsTwoFactor, QUIET_BUTTON } from './settings-parts'

const DELIVERY_MESSAGE: Record<NameserverDelivery, string> = {
  queued: 'Sent to the registry. The history shows it once it is applied.',
  after_registration: 'Saved. They are applied as soon as the registration completes.',
  demo: 'Saved. This is a demo domain, so nothing is sent to a registry.',
}

/**
 * FR-N5 — one click back to the set the domain had before. Not a write of
 * its own: it asks `requestNameservers` for that set, so it takes the same
 * second factor (SEC-2) and the same live DNS check (FR-D4) as typing the
 * set in — a host that has since gone away is caught, not restored.
 *
 * Stays on the page once the revert is asked for (`waiting`), so what it
 * answered is still there after the page refreshes.
 */
export function RevertNameservers({
  domainId,
  domain,
  previous,
  waiting,
  hasTwoFactor,
}: {
  domainId: string
  domain: string
  previous: string[]
  /** That set is already on its way to the registry. */
  waiting: boolean
  hasTwoFactor: boolean
}) {
  const revert = useAction(requestNameservers)
  const data = revert.result.data
  const set = previous.join(', ')

  if (!hasTwoFactor && !waiting) {
    return (
      <NeedsTwoFactor>
        Going back to {set} changes where your website and email live, so it needs two-factor
        authentication on your account.
      </NeedsTwoFactor>
    )
  }

  return (
    <div className="space-y-3">
      {data && 'ok' in data ? (
        <FormMessage tone="success">
          {data.unchanged
            ? 'Those are already the nameservers on file — nothing to change.'
            : DELIVERY_MESSAGE[data.delivery]}
          {data.warnings.length ? (
            <ul className="mt-1 list-disc pl-5">
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </FormMessage>
      ) : waiting ? (
        <p className="text-pretty text-sm/6 text-muted-foreground">
          Going back to <span className="font-mono text-xs break-all text-foreground">{set}</span>{' '}
          has been asked for, and waits to be applied.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={revert.isPending}
            aria-busy={revert.isPending || undefined}
            onClick={() =>
              revert.execute({ domainId, nameservers: previous.join('\n'), presetId: null })
            }
            className={cn(QUIET_BUTTON, 'h-auto min-h-11 py-2 text-left')}
          >
            {revert.isPending ? (
              <Spinner className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <Undo2 className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 break-all">
              {revert.isPending ? 'Checking each nameserver…' : `Revert to ${set}`}
            </span>
          </button>
          <p className="text-pretty text-xs/5 text-muted-foreground">
            The set {domain} had before its last change. It is checked in DNS first, like any
            change, and whatever the current host serves stops working once the registry applies it.
          </p>
        </>
      )}
      {data && 'error' in data ? (
        <FormMessage tone="error">
          <p>{data.error}</p>
          {data.details?.length ? (
            <ul className="mt-1 list-disc pl-5">
              {data.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </FormMessage>
      ) : null}
      <ActionError
        message={revert.result.serverError ?? null}
        returnTo={`/app/domains/${domain}/nameservers`}
      />
    </div>
  )
}
