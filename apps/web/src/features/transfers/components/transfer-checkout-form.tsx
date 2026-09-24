'use client'

import { Eye, EyeOff, Lock } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { FOCUS, PANEL } from '@/components/layout/panel'
import { RegistrantFields } from '@/features/checkout/components/registrant-fields'
import { type RegistrantForm, registrantFromForm } from '@/features/checkout/lib/contact'
import { cn } from '@/lib/utils'
import { placeTransfer } from '../actions/place-transfer'

export type TransferSummary = {
  transfer: string
  renewal: string
  vatPct: number
  vat: string
  total: string
  totalKobo: number
  includesIcannFee: boolean
}

/**
 * FR-T2 — the transfer code, who owns the domain, and the whole price, then
 * payment. The code is checked with the registry before Flutterwave opens (N4).
 */
/** next-safe-action's formatted errors for one field of the `registrant` group. */
function registrantError(errors: unknown, field: string): string | undefined {
  const group = (errors as Record<string, Record<string, { _errors?: string[] }>> | undefined)
    ?.registrant
  return group?.[field]?._errors?.[0]
}

export function TransferCheckoutForm({
  domain,
  registrant,
  summary,
  testMode,
}: {
  domain: string
  registrant: RegistrantForm
  summary: TransferSummary
  testMode: boolean
}) {
  const id = useId()
  const [showCode, setShowCode] = useState(false)
  const place = useAction(placeTransfer, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) window.location.assign(data.redirectTo)
    },
  })
  const errors = place.result.validationErrors
  const data = place.result.data
  const failure = data && 'error' in data ? data : null
  const redirecting = Boolean(data && 'redirectTo' in data)
  const pending = place.isPending || redirecting
  const codeError =
    fieldError(errors, 'authCode') ?? (failure?.field === 'authCode' ? failure.error : undefined)

  return (
    <form
      aria-label="Transfer checkout"
      noValidate
      className="grid gap-4 xl:grid-cols-[1.6fr_1fr]"
      onSubmit={onSubmitWith((form) =>
        place.execute({
          domain,
          authCode: String(form.get('authCode') ?? ''),
          registrant: registrantFromForm(form),
          expectedTotalKobo: summary.totalKobo,
        }),
      )}
    >
      <div className={cn(PANEL, 'space-y-10 p-5 sm:p-7')}>
        {testMode ? (
          <FormMessage tone="success">
            <span className="font-medium">Test mode.</span> Payments use Flutterwave test keys — no
            real money moves, and the transfer goes to the registrar’s test system, never the live
            registry.
          </FormMessage>
        ) : null}

        <section aria-labelledby={`${id}-code`}>
          <h2 id={`${id}-code`} className="text-lg font-semibold text-foreground">
            The transfer code
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Your current registrar gives you this — it may be called the EPP, auth or authorisation
            code. We check it with the registry before you pay, and delete it once the registry has
            the transfer request.
          </p>
          <div className="mt-6 max-w-md">
            <Field id={`${id}-authCode`} label="Transfer code" error={codeError}>
              <div className="flex gap-2">
                <input
                  id={`${id}-authCode`}
                  name="authCode"
                  type={showCode ? 'text' : 'password'}
                  // A one-off secret: no autofill, no saved passwords, no spellcheck.
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  aria-invalid={codeError ? true : undefined}
                  aria-describedby={describedBy(`${id}-authCode`, codeError)}
                  className={cn(inputClass, 'font-mono')}
                />
                <button
                  type="button"
                  onClick={() => setShowCode((shown) => !shown)}
                  aria-pressed={showCode}
                  aria-label={showCode ? 'Hide the transfer code' : 'Show the transfer code'}
                  className={cn(
                    'grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-background text-foreground transition hover:bg-muted active:scale-[0.97] disabled:opacity-60',
                    FOCUS,
                  )}
                >
                  {showCode ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </Field>
          </div>
        </section>

        <section aria-labelledby={`${id}-registrant`}>
          <h2 id={`${id}-registrant`} className="text-lg font-semibold text-foreground">
            Who owns the domain
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            The registrant we keep on record for {domain}, sent to the registry with the transfer
            request. Use your real details: an owner the registry cannot verify can lose the domain.
          </p>
          <div className="mt-6">
            <RegistrantFields
              idPrefix={id}
              registrant={registrant}
              errorFor={(name) => registrantError(errors, name)}
            />
          </div>
        </section>
      </div>

      <aside
        aria-labelledby={`${id}-review`}
        className={cn(PANEL, 'h-fit space-y-6 p-5 sm:p-7 xl:sticky xl:top-4')}
      >
        <h2 id={`${id}-review`} className="text-lg font-semibold text-foreground">
          Check and pay
        </h2>

        <div>
          <p className="text-xl font-bold tracking-tight break-all text-foreground">{domain}</p>
          {/* N8 — never a price without its renewal price. */}
          <p className="text-sm text-muted-foreground">
            Transfer {summary.transfer}, then renews at {summary.renewal}/yr
            {summary.includesIcannFee ? ' · includes the ICANN fee' : ''}
          </p>
        </div>

        {/* FR-C5 — every part of the total, nothing behind a tooltip. */}
        <dl className="space-y-2.5 border-border border-t pt-5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Transfer</dt>
            <dd className="font-medium text-foreground tabular-nums">{summary.transfer}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">VAT ({summary.vatPct}%)</dt>
            <dd className="font-medium text-foreground tabular-nums">{summary.vat}</dd>
          </div>
          <div className="flex justify-between gap-4 border-border border-t pt-2.5 text-base">
            <dt className="font-semibold text-foreground">Total</dt>
            <dd className="font-bold text-foreground tabular-nums">{summary.total}</dd>
          </div>
        </dl>
        <p className="-mt-3 text-pretty text-xs/5 text-muted-foreground">
          Includes an extra year on your registration where the registry adds one.
        </p>

        {failure && failure.field !== 'authCode' ? (
          <FormMessage tone="error">{failure.error}</FormMessage>
        ) : null}
        {place.result.serverError ? (
          <FormMessage tone="error">{place.result.serverError}</FormMessage>
        ) : null}
        {errors ? (
          <FormMessage tone="error">
            Some details need fixing — they’re marked on the left.
          </FormMessage>
        ) : failure?.field === 'authCode' ? (
          <FormMessage tone="error">
            The transfer code needs another look — see the note under it.
          </FormMessage>
        ) : null}

        <SubmitButton
          pending={pending}
          pendingLabel={redirecting ? 'Taking you to Flutterwave…' : 'Checking the code…'}
          className="h-12 text-base"
        >
          <Lock className="size-4" aria-hidden="true" />
          Pay {summary.total}
        </SubmitButton>
        <p className="text-pretty text-xs/5 text-muted-foreground">
          You pay on Flutterwave’s secure page — card, bank transfer or USSD. Before you are charged
          we check the transfer code with the registry. If the transfer is refused later, what you
          paid is refunded automatically.
        </p>
        <p className="text-pretty text-xs/5 text-muted-foreground">
          By paying you agree to the{' '}
          <Link href="/legal/registration-agreement" className="underline hover:text-foreground">
            registration agreement
          </Link>{' '}
          and{' '}
          <Link href="/legal/refunds" className="underline hover:text-foreground">
            refund policy
          </Link>
          .
        </p>
      </aside>
    </form>
  )
}
