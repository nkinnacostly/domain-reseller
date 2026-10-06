'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FormMessage } from '@/components/common/form-parts'
import { StatusPill } from '@/components/common/status-pill'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { scheduleChange, startCheckout } from '../actions/billing'
import type { OptionCopy } from '../lib/plan-copy'
import { BILLING_FALLBACK } from '../lib/words'
import { primaryButtonClass, secondaryButtonClass } from './styles'

/** One plan, as the server worded it (lib/plan-copy.ts): no amount is worked out here. */
export type PlanCard = {
  code: string
  name: string
  price: string
  caps: string[]
  copy: OptionCopy
}

type ActionResult = { data?: unknown; serverError?: string; validationErrors?: unknown }

function errorOf(result: ActionResult): string | null {
  const data = result.data as { error?: string } | undefined
  if (data?.error) return data.error
  if (result.serverError) return result.serverError
  return result.validationErrors ? BILLING_FALLBACK : null
}

/** Pay: SQL quotes and starts the checkout, then Flutterwave's page takes over. */
function CheckoutButton({
  accountId,
  plan,
  label,
  totalKobo,
}: {
  accountId: string
  plan: string
  label: string
  totalKobo: number
}) {
  const [leaving, setLeaving] = useState(false)
  const pay = useAction(startCheckout, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) {
        setLeaving(true)
        window.location.assign(data.redirectTo)
      }
    },
  })
  const pending = pay.isPending || leaving
  const error = errorOf(pay.result)
  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => pay.execute({ accountId, planCode: plan, expectedTotalKobo: totalKobo })}
        className={cn(primaryButtonClass, 'w-full whitespace-normal')}
      >
        {pending ? (
          <>
            <Spinner className="size-4" aria-hidden="true" />
            Opening Flutterwave…
          </>
        ) : (
          label
        )}
      </button>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  )
}

/** A move at the period's end: asked once more, with what it means. */
function ScheduleButton({
  accountId,
  plan,
  copy,
}: {
  accountId: string
  plan: string
  copy: Extract<OptionCopy['action'], { kind: 'schedule' }> & { lines: string[] }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const change = useAction(scheduleChange, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setOpen(false)
        router.refresh()
      }
    },
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) change.reset()
        setOpen(next)
      }}
      trigger={
        <button type="button" className={cn(secondaryButtonClass, 'w-full whitespace-normal')}>
          {copy.label}
        </button>
      }
      title={copy.confirm.title}
      description={
        <div className="space-y-2">
          {copy.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      }
      confirmLabel={copy.confirm.confirmLabel}
      pendingLabel={copy.confirm.pendingLabel}
      pending={change.isPending}
      error={errorOf(change.result)}
      onConfirm={() => change.execute({ accountId, planCode: plan })}
    />
  )
}

/**
 * Change plan (MAIL-SPEC §8, §10): every offered plan with its price, caps
 * and what choosing it does, in words, before anyone chooses (N9b). Buttons
 * only for those who manage billing, and only while paid plans are on sale.
 */
export function PlanOptions({
  accountId,
  plans,
  canAct,
}: {
  accountId: string
  plans: PlanCard[]
  canAct: boolean
}) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {plans.map((plan) => {
        const { copy } = plan
        return (
          <li
            key={plan.code}
            data-plan={plan.code}
            className={cn(
              'flex min-w-0 flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6',
              copy.badge === 'Your plan' ? 'border-primary' : 'border-border',
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <p className="text-sm text-muted-foreground">{plan.price}</p>
              </div>
              {copy.badge ? (
                <StatusPill tone={copy.badge === 'Your plan' ? 'info' : 'warning'}>
                  {copy.badge}
                </StatusPill>
              ) : null}
            </div>
            <ul className="space-y-1 text-sm/6 text-muted-foreground">
              {plan.caps.map((cap) => (
                <li key={cap}>{cap}</li>
              ))}
            </ul>
            {copy.lines.length > 0 ? (
              <div className="space-y-2 text-pretty text-sm/6">
                {copy.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            ) : null}
            {canAct && copy.action.kind !== 'none' ? (
              <div className="mt-auto pt-2">
                {copy.action.kind === 'checkout' ? (
                  <CheckoutButton
                    accountId={accountId}
                    plan={plan.code}
                    label={copy.action.label}
                    totalKobo={copy.action.totalKobo}
                  />
                ) : (
                  <ScheduleButton
                    accountId={accountId}
                    plan={plan.code}
                    copy={{ ...copy.action, lines: copy.lines }}
                  />
                )}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
