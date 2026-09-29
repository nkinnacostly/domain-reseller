'use client'

import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { DomainName } from '@/components/common/domain-name'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { PROCESSING_FEE_NOTE } from '@/features/checkout/lib/fees'
import { placeRenewals } from '../actions/place-renewals'

/** A domain in the order, as every choice of years shows it. */
export type BulkRenewalDomain = {
  id: string
  domainName: string
  /** Its expiry now, formatted. */
  expires: string
  /** N8 — its renewal price with its term: "₦18,700/yr", "₦273,000 every 2 years". */
  renewal: string
  /** FR-RN7 — set when the renewal price is higher than last paid or promised, with its term. */
  priceRise: { from: string; to: string } | null
}

/** One choice of years, priced and dated on the server so both render alike. */
export type BulkRenewalOption = {
  years: number
  subtotal: string
  vat: string
  total: string
  totalKobo: number
  lines: Record<string, { newExpiry: string; price: string }>
}

/**
 * FR-P4, FR-P5 — renew several domains for the same years: each line's new
 * expiry and price, the whole total, then one payment on Flutterwave.
 */
export function BulkRenewForm({
  domains,
  options,
  vatPct,
  testMode,
}: {
  domains: BulkRenewalDomain[]
  options: BulkRenewalOption[]
  vatPct: number
  testMode: boolean
}) {
  const id = useId()
  const [years, setYears] = useState(options[0]?.years ?? 1)
  const chosen = options.find((option) => option.years === years) ?? options[0]
  const place = useAction(placeRenewals, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) window.location.assign(data.redirectTo)
    },
  })
  const data = place.result.data
  const failure = data && 'error' in data ? data.error : null
  const redirecting = Boolean(data && 'redirectTo' in data)
  if (!chosen) return null
  const rises = domains.filter((domain) => domain.priceRise)

  return (
    <form
      noValidate
      aria-label="Renew these domains"
      onSubmit={onSubmitWith(() =>
        place.execute({
          domainIds: domains.map((domain) => domain.id),
          years: chosen.years,
          expectedTotalKobo: chosen.totalKobo,
        }),
      )}
      className="space-y-5"
    >
      {testMode ? (
        <FormMessage tone="success">
          <span className="font-medium">Test mode.</span> Payments use Flutterwave test keys — no
          real money moves, and the renewals are made in the registrar’s test system.
        </FormMessage>
      ) : null}

      <div>
        <label htmlFor={`${id}-years`} className="text-sm font-medium text-foreground">
          Renew each for
        </label>
        <select
          id={`${id}-years`}
          name="years"
          value={chosen.years}
          disabled={place.isPending || redirecting}
          onChange={(event) => setYears(Number(event.target.value))}
          aria-describedby={`${id}-years-hint`}
          className="mt-1.5 block h-11 w-full max-w-xs rounded-xl border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 sm:text-sm"
        >
          {options.map((option) => (
            <option key={option.years} value={option.years}>
              {option.years} {option.years === 1 ? 'year' : 'years'} — {option.total}
            </option>
          ))}
        </select>
        <p id={`${id}-years-hint`} className="mt-2 text-pretty text-sm text-muted-foreground">
          The same for every domain, so the longest on offer is what the domain closest to the
          ten-year limit can take
          {options.some((option, index) => option.years !== index + 1)
            ? ', and only periods every domain’s registry renews in.'
            : '.'}
        </p>
      </div>

      {/* FR-RN7 — a higher renewal price is said before paying, never after. */}
      {rises.length > 0 ? (
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
          <p className="font-medium text-foreground">Some renewal prices have gone up.</p>
          <ul className="mt-1 list-disc pl-5">
            {rises.map((domain) => (
              <li key={domain.id}>
                {domain.domainName}: now {domain.priceRise?.to}, up from {domain.priceRise?.from}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul aria-label="Domains to renew" className="space-y-2">
        {domains.map((domain) => {
          const line = chosen.lines[domain.id]
          return (
            <li
              key={domain.id}
              data-renew-line={domain.domainName}
              className="flex flex-col gap-1 rounded-2xl border border-border bg-background/80 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5"
            >
              <div className="min-w-0">
                <p className="font-medium break-all text-foreground">
                  <DomainName name={domain.domainName} />
                </p>
                <p className="text-muted-foreground">
                  Expires {domain.expires} →{' '}
                  <span className="text-foreground">{line?.newExpiry}</span> · renews at{' '}
                  {domain.renewal}
                </p>
              </div>
              <p className="font-medium text-foreground tabular-nums">{line?.price}</p>
            </li>
          )
        })}
      </ul>

      {/* FR-C5 — every part of the total, nothing behind a tooltip. */}
      <dl className="space-y-2.5 border-border border-t pt-5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">
            Renewals ({domains.length} × {chosen.years} {chosen.years === 1 ? 'year' : 'years'})
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
        You pay once, on Flutterwave’s secure page — card, bank transfer or USSD.{' '}
        {PROCESSING_FEE_NOTE} Each renewal is made once the payment is confirmed. If the registry
        refuses one, what you paid for it is refunded automatically.
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
