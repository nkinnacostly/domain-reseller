'use client'

import { ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'
import { describedBy, inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { correctTopup, recordTopup } from '@/features/admin/actions/supplier'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { CORRECT_TOPUP, RECORD_TOPUP, TOPUP_FIELDS } from '@/features/admin/lib/supplier-copy'
import {
  creditWords,
  formatPaid,
  nairaToKobo,
  rateKoboPerCent,
  rateWords,
} from '@/features/admin/lib/supplier-topups'
import { cn } from '@/lib/utils'

/**
 * "Record what it cost" and "Correct" on a top-up row (docs/ADMIN-SPEC.md
 * §5.2 B6; money, owner): the naira paid and the reference are typed here,
 * then the dialog shows the credit, both, and the effective rate against
 * costing, and asks for a reason and the authenticator code (D6).
 */
export function TopupAction({
  mode,
  traceId,
  topupId,
  usdCents,
  occurredAt,
  costing,
}: {
  mode: 'record' | 'correct'
  traceId: string
  topupId?: number | null
  usdCents: number
  occurredAt: string
  costing: number | null
}) {
  const id = useId()
  const copy = mode === 'record' ? RECORD_TOPUP : CORRECT_TOPUP
  const [paidText, setPaidText] = useState('')
  const [reference, setReference] = useState('')
  const [touched, setTouched] = useState(false)

  const kobo = nairaToKobo(paidText)
  const trimmed = reference.trim()
  const paidError =
    touched && paidText !== '' && kobo === null ? TOPUP_FIELDS.paidInvalid : undefined
  const referenceError =
    touched && reference !== '' && (trimmed.length < 1 || trimmed.length > 80)
      ? TOPUP_FIELDS.referenceInvalid
      : undefined
  const ready = kobo !== null && trimmed.length >= 1 && trimmed.length <= 80
  const rate = kobo === null ? null : rateKoboPerCent(kobo, usdCents)

  return (
    <details className="group min-w-0">
      <summary
        className={cn(
          'inline-flex h-11 cursor-pointer list-none items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] [&::-webkit-details-marker]:hidden',
          FOCUS,
        )}
      >
        {copy.trigger}
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-3 grid gap-3 sm:max-w-sm">
        <div>
          <label htmlFor={`${id}-paid`} className="text-sm font-medium text-foreground">
            {TOPUP_FIELDS.paid}
          </label>
          <input
            id={`${id}-paid`}
            inputMode="decimal"
            autoComplete="off"
            value={paidText}
            onChange={(event) => setPaidText(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={paidError ? true : undefined}
            aria-describedby={describedBy(`${id}-paid`, paidError, TOPUP_FIELDS.paidHint)}
            className={cn(inputClass, 'mt-1.5 tabular-nums')}
          />
          {paidError ? (
            <p id={`${id}-paid-error`} className="mt-1.5 text-sm text-destructive">
              {paidError}
            </p>
          ) : (
            <p id={`${id}-paid-hint`} className="mt-1.5 text-xs text-muted-foreground">
              {TOPUP_FIELDS.paidHint}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-ref`} className="text-sm font-medium text-foreground">
            {TOPUP_FIELDS.reference}
          </label>
          <input
            id={`${id}-ref`}
            autoComplete="off"
            maxLength={80}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={referenceError ? true : undefined}
            aria-describedby={describedBy(`${id}-ref`, referenceError, TOPUP_FIELDS.referenceHint)}
            className={cn(inputClass, 'mt-1.5')}
          />
          {referenceError ? (
            <p id={`${id}-ref-error`} className="mt-1.5 text-sm text-destructive">
              {referenceError}
            </p>
          ) : (
            <p id={`${id}-ref-hint`} className="mt-1.5 text-xs text-muted-foreground">
              {TOPUP_FIELDS.referenceHint}
            </p>
          )}
        </div>
        <ConfirmAction
          trigger={copy.confirm}
          title={copy.title}
          body={copy.body}
          rows={[
            { label: RECORD_TOPUP.rows.credit, value: creditWords({ usdCents, occurredAt }) },
            { label: RECORD_TOPUP.rows.paid, value: formatPaid(kobo) },
            { label: RECORD_TOPUP.rows.reference, value: trimmed || '—' },
            { label: RECORD_TOPUP.rows.rate, value: rateWords(rate, costing) },
          ]}
          confirmLabel={copy.confirm}
          cancelLabel={copy.cancel}
          reason="required"
          needsCode
          disabled={!ready}
          returnTo="/admin/supplier"
          successMessage={copy.done}
          run={async ({ reason, requestKey, code }) => {
            if (kobo === null) throw new Error('not ready')
            const common = {
              ngnPaidKobo: kobo,
              reference: trimmed,
              reason: reason ?? '',
              requestKey,
              code: code ?? '',
            }
            return adminOutcome(
              mode === 'record'
                ? await recordTopup({ traceId, ...common })
                : await correctTopup({ topupId: topupId ?? 0, ...common }),
            )
          }}
        />
      </div>
    </details>
  )
}
