'use client'

import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { PROCESSING_FEE_NOTE } from '@/features/checkout/lib/fees'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { placeRenewal } from '../actions/place-renewal'

/** One choice of years, priced and dated on the server so both render alike. */
export type RenewalOption = {
  years: number
  newExpiry: string
  subtotal: string
  vat: string
  total: string
  totalKobo: number
}

/** FR-RN1 — choose the years, see the new expiry and the whole price, then pay. */
export function RenewForm({
  domainId,
  domainName,
  renewal,
  vatPct,
  options,
  priceRise,
  testMode,
}: {
  domainId: string
  domainName: string
  /** The shortest renewal the registry sells and its price: a year for most, 2 for .ai. */
  renewal: { price: string; years: number }
  vatPct: number
  options: RenewalOption[]
  /** FR-RN7 — the renewal price then and now, each with its term. */
  priceRise: { from: string; to: string } | null
  testMode: boolean
}) {
  const id = useId()
  const [years, setYears] = useState(options[0]?.years ?? 1)
  const chosen = options.find((option) => option.years === years) ?? options[0]
  const place = useAction(placeRenewal, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) window.location.assign(data.redirectTo)
    },
  })
  const data = place.result.data
  const failure = data && 'error' in data ? data.error : null
  const redirecting = Boolean(data && 'redirectTo' in data)
  if (!chosen) return null

  return (
    <form
      noValidate
      onSubmit={onSubmitWith(() =>
        place.execute({ domainId, years: chosen.years, expectedTotalKobo: chosen.totalKobo }),
      )}
      className="space-y-5"
    >
      {testMode ? (
        <FormMessage tone="success">
          <span className="font-medium">Test mode.</span> Payments use Flutterwave test keys — no
          real money moves, and the renewal is made in the registrar’s test system.
        </FormMessage>
      ) : null}

      {/* FR-RN7 — a higher renewal price is said before paying, never after. */}
      {priceRise ? (
        <PanelNote title="The renewal price has gone up.">
          It is now {priceRise.to}, up from the {priceRise.from} quoted when you last paid for{' '}
          {domainName}.
        </PanelNote>
      ) : null}

      <div>
        <label htmlFor={`${id}-years`} className="text-sm font-medium text-foreground">
          Renew for
        </label>
        <select
          id={`${id}-years`}
          name="years"
          value={chosen.years}
          disabled={place.isPending || redirecting}
          onChange={(event) => setYears(Number(event.target.value))}
          aria-describedby={`${id}-expiry`}
          className="mt-1.5 block h-11 w-full max-w-xs rounded-xl border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 sm:text-sm"
        >
          {options.map((option) => (
            <option key={option.years} value={option.years}>
              {option.years} {option.years === 1 ? 'year' : 'years'} — {option.subtotal}
            </option>
          ))}
        </select>
        <p id={`${id}-expiry`} className="mt-2 text-sm text-muted-foreground">
          New expiry: <span className="font-medium text-foreground">{chosen.newExpiry}</span>
        </p>
      </div>

      {/* FR-C5 — every part of the total, nothing behind a tooltip. */}
      <dl className="space-y-2.5 border-border border-t pt-5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">
            {renewal.years === 1
              ? `Renewal (${chosen.years} × ${renewal.price})`
              : `Renewal (${chosen.years} years, at ${renewal.price} every ${renewal.years})`}
          </dt>
          <dd className="font-medium text-foreground tabular-nums">{chosen.subtotal}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">VAT ({vatPct}%)</dt>
          <dd className="font-medium text-foreground tabular-nums">{chosen.vat}</dd>
        </div>
        <div className="flex justify-between gap-4 border-border border-t pt-2.5 text-base">
          <dt className="font-semibold text-foreground">Total</dt>
          <dd className="font-bold text-foreground tabular-nums">{chosen.total}</dd>
        </div>
      </dl>

      {failure ? <FormMessage tone="error">{failure}</FormMessage> : null}
      {place.result.serverError ? (
        <FormMessage tone="error">{place.result.serverError}</FormMessage>
      ) : null}

      <SubmitButton
        pending={place.isPending || redirecting}
        pendingLabel={redirecting ? 'Taking you to Flutterwave…' : 'Checking everything…'}
        className="h-12 text-base"
      >
        <Lock className="size-4" aria-hidden="true" />
        Pay {chosen.total}
      </SubmitButton>
      <p className="text-pretty text-xs/5 text-muted-foreground">
        You pay on Flutterwave’s secure page — card, bank transfer or USSD. {PROCESSING_FEE_NOTE}{' '}
        The renewal is made once the payment is confirmed. If the registry refuses it, what you paid
        is refunded automatically.
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
    </form>
  )
}
