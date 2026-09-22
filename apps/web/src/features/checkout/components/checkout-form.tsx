'use client'

import { Lock } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { useId, useMemo, useState } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { placeOrder } from '../actions/place-order'
import type { RegistrantForm } from '../lib/contact'
import { NIGERIAN_STATES, REGISTRANT_COUNTRIES } from '../lib/countries'

export type CheckoutLine = {
  domain: string
  years: number
  total: string
  renewal: string
  includesIcannFee: boolean
}

type Summary = { subtotal: string; vatPct: number; vat: string; total: string; totalKobo: number }

/** next-safe-action's formatted errors, one level of nesting deep. */
function nestedError(errors: unknown, group: string, field: string): string | undefined {
  const node = (errors as Record<string, Record<string, { _errors?: string[] }>> | undefined)?.[
    group
  ]?.[field]
  return node?._errors?.[0]
}
function topError(errors: unknown, field: string): string | undefined {
  return (errors as Record<string, { _errors?: string[] }> | undefined)?.[field]?._errors?.[0]
}

export function CheckoutForm({
  lines,
  summary,
  registrant,
  testMode,
}: {
  lines: CheckoutLine[]
  summary: Summary
  registrant: RegistrantForm
  testMode: boolean
}) {
  const id = useId()
  const [country, setCountry] = useState(registrant.country ?? 'NG')
  const place = useAction(placeOrder, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) window.location.assign(data.redirectTo)
    },
  })
  const errors = place.result.validationErrors
  const data = place.result.data
  const failure = data && 'error' in data ? data : null
  const redirecting = Boolean(data && 'redirectTo' in data)

  const countryNames = useMemo(() => new Intl.DisplayNames(['en'], { type: 'region' }), [])

  const field = (name: keyof RegistrantForm) => {
    const error = nestedError(errors, 'registrant', name)
    return {
      id: `${id}-${name}`,
      name,
      defaultValue: (registrant[name] as string | undefined) ?? '',
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy(`${id}-${name}`, error),
      className: inputClass,
      error,
    }
  }
  const input = (name: keyof RegistrantForm, extra: React.ComponentProps<'input'> = {}) => {
    const { error: _error, ...props } = field(name)
    return <input {...props} {...extra} />
  }

  return (
    <form
      aria-label="Checkout"
      noValidate
      className="grid gap-10 lg:grid-cols-[1.6fr_1fr] lg:gap-14"
      onSubmit={onSubmitWith((form) => {
        const value = (name: string) => String(form.get(name) ?? '')
        place.execute({
          registrant: {
            firstName: value('firstName'),
            lastName: value('lastName'),
            company: value('company'),
            email: value('email'),
            phoneCountryCode: value('phoneCountryCode'),
            phone: value('phone'),
            addressLine1: value('addressLine1'),
            addressLine2: value('addressLine2'),
            city: value('city'),
            state: value('state'),
            zipCode: value('zipCode'),
            country: value('country'),
          },
          nameservers: value('nameservers'),
          confirmed: form.get('confirmed') === 'on' ? true : (false as unknown as true),
          expectedTotalKobo: summary.totalKobo,
        })
      })}
    >
      <div className="space-y-10">
        {testMode ? (
          <FormMessage tone="success">
            <span className="font-medium">Test mode.</span> Payments use Flutterwave test keys — no
            real money moves, and no domain is registered.
          </FormMessage>
        ) : null}

        <section aria-labelledby={`${id}-registrant`}>
          <h2 id={`${id}-registrant`} className="text-lg font-semibold text-foreground">
            Who owns the domains
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            The registrant — the legal owner the registry records. Use your real details: an owner
            the registry cannot verify can lose the domain. Contact privacy keeps them out of public
            lookups where it is on.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-firstName`} label="First name" error={field('firstName').error}>
              {input('firstName', { autoComplete: 'given-name' })}
            </Field>
            <Field id={`${id}-lastName`} label="Last name" error={field('lastName').error}>
              {input('lastName', { autoComplete: 'family-name' })}
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${id}-company`} label="Company (optional)" error={field('company').error}>
                {input('company', { autoComplete: 'organization' })}
              </Field>
            </div>
            <Field id={`${id}-email`} label="Email" error={field('email').error}>
              {input('email', { type: 'email', autoComplete: 'email', inputMode: 'email' })}
            </Field>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <Field
                id={`${id}-phoneCountryCode`}
                label="Code"
                error={field('phoneCountryCode').error}
              >
                {input('phoneCountryCode', {
                  inputMode: 'numeric',
                  autoComplete: 'tel-country-code',
                })}
              </Field>
              <Field id={`${id}-phone`} label="Phone" error={field('phone').error}>
                {input('phone', {
                  type: 'tel',
                  autoComplete: 'tel-national',
                  inputMode: 'tel',
                  placeholder: '0803 123 4567',
                })}
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                id={`${id}-addressLine1`}
                label="Street address"
                error={field('addressLine1').error}
              >
                {input('addressLine1', { autoComplete: 'address-line1' })}
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                id={`${id}-addressLine2`}
                label="Address line 2 (optional)"
                error={field('addressLine2').error}
              >
                {input('addressLine2', { autoComplete: 'address-line2' })}
              </Field>
            </div>
            <Field id={`${id}-city`} label="City" error={field('city').error}>
              {input('city', { autoComplete: 'address-level2' })}
            </Field>
            <Field id={`${id}-state`} label="State" error={field('state').error}>
              {input('state', {
                autoComplete: 'address-level1',
                list: country === 'NG' ? `${id}-ng-states` : undefined,
              })}
            </Field>
            <datalist id={`${id}-ng-states`}>
              {NIGERIAN_STATES.map((state) => (
                <option key={state} value={state} />
              ))}
            </datalist>
            <Field
              id={`${id}-zipCode`}
              label="Postcode"
              error={field('zipCode').error}
              hint={
                country === 'NG'
                  ? 'Nigerian postcodes are 6 digits — 100001 is central Lagos.'
                  : undefined
              }
            >
              {input('zipCode', {
                autoComplete: 'postal-code',
                'aria-describedby': describedBy(
                  `${id}-zipCode`,
                  field('zipCode').error,
                  country === 'NG' ? 'hint' : undefined,
                ),
              })}
            </Field>
            <Field id={`${id}-country`} label="Country" error={field('country').error}>
              <select
                id={`${id}-country`}
                name="country"
                value={country}
                onChange={(event) => setCountry(event.target.value)}
                autoComplete="country"
                className={inputClass}
              >
                {REGISTRANT_COUNTRIES.map((code) => (
                  <option key={code} value={code}>
                    {countryNames.of(code) ?? code}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <details className="group rounded-2xl border border-border p-5">
          <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
            Already know where this domain is going?{' '}
            <span className="font-normal text-muted-foreground">Optional</span>
          </summary>
          <div className="mt-4">
            <Field
              id={`${id}-nameservers`}
              label="Nameservers from your host"
              error={
                topError(errors, 'nameservers') ??
                (failure?.field === 'nameservers' ? failure.error : undefined)
              }
              hint="Paste the two or more your host gave you, one per line. We apply them the moment the domain is registered — or skip this and do it later."
            >
              <textarea
                id={`${id}-nameservers`}
                name="nameservers"
                rows={3}
                placeholder={'ns1.yourhost.com\nns2.yourhost.com'}
                spellCheck={false}
                autoCapitalize="none"
                aria-describedby={describedBy(`${id}-nameservers`, undefined, 'hint')}
                className={`${inputClass} h-auto py-2.5 font-mono text-sm`}
              />
            </Field>
          </div>
        </details>
      </div>

      <aside
        aria-labelledby={`${id}-review`}
        className="h-fit space-y-6 rounded-3xl border border-border bg-background p-6 lg:sticky lg:top-8"
      >
        <h2 id={`${id}-review`} className="text-lg font-semibold text-foreground">
          Check and pay
        </h2>

        {/* FR-C6 — every name in large type, so a typo is caught while it is still free. */}
        <ul aria-label="Domains you are buying" className="space-y-4">
          {lines.map((line) => (
            <li key={line.domain}>
              <p className="text-xl font-bold tracking-tight break-all text-foreground">
                {line.domain}
              </p>
              <p className="text-sm text-muted-foreground">
                {line.years} {line.years === 1 ? 'year' : 'years'} · {line.total}, then{' '}
                {line.renewal}/yr
                {line.includesIcannFee ? ' · includes the ICANN fee' : ''}
              </p>
            </li>
          ))}
        </ul>

        {/* FR-C5 — every line itemised, nothing behind a tooltip. */}
        <dl className="space-y-2.5 border-border border-t pt-5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Domains</dt>
            <dd className="font-medium text-foreground tabular-nums">{summary.subtotal}</dd>
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

        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted/60 p-4 text-sm/6">
          <input
            type="checkbox"
            name="confirmed"
            aria-invalid={topError(errors, 'confirmed') ? true : undefined}
            aria-describedby={topError(errors, 'confirmed') ? `${id}-confirmed-error` : undefined}
            className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-foreground">
            I've checked the spelling. Domain registrations cannot be cancelled or refunded.
          </span>
        </label>
        {topError(errors, 'confirmed') ? (
          <p id={`${id}-confirmed-error`} className="-mt-3 text-sm text-destructive">
            {topError(errors, 'confirmed')}
          </p>
        ) : null}

        {failure && failure.field !== 'nameservers' ? (
          <FormMessage tone="error">{failure.error}</FormMessage>
        ) : null}
        {place.result.serverError ? (
          <FormMessage tone="error">{place.result.serverError}</FormMessage>
        ) : null}
        {errors && !failure ? (
          <FormMessage tone="error">Some details need fixing — they're marked above.</FormMessage>
        ) : null}

        <SubmitButton
          pending={place.isPending || redirecting}
          pendingLabel={redirecting ? 'Taking you to Flutterwave…' : 'Checking everything…'}
          className="h-12 text-base"
        >
          <Lock className="size-4" aria-hidden="true" />
          Pay {summary.total}
        </SubmitButton>
        <p className="text-pretty text-xs/5 text-muted-foreground">
          You pay on Flutterwave's secure page — card, bank transfer or USSD. Before you are charged
          we check every name is still free.
        </p>
      </aside>
    </form>
  )
}
