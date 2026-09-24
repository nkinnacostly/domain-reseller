'use client'

import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { DomainName } from '@/components/common/domain-name'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { PANEL } from '@/components/layout/panel'
import { TWO_FACTOR_SETTINGS_HREF } from '@/features/auth/lib/security'
import { ContactRoles } from '@/features/contacts/components/contact-roles'
import type { ProfileOption } from '@/features/contacts/lib/profiles'
import { contactRolesFromForm } from '@/features/contacts/lib/roles'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { cn } from '@/lib/utils'
import { placeOrder } from '../actions/place-order'
import { type RegistrantForm, registrantFromForm } from '../lib/contact'
import { PROCESSING_FEE_NOTE } from '../lib/fees'
import { type HostProblem, hostFailure, hostRequest, isHostFailure } from '../lib/line-hosts'
import { HostWarnings } from './host-warnings'
import { NameserverChoice } from './nameserver-choice'
import { RegistrantFields } from './registrant-fields'

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
  presets = [],
  profiles = [],
}: {
  lines: CheckoutLine[]
  summary: Summary
  registrant: RegistrantForm
  testMode: boolean
  /** FR-C10 — verified, visible host presets (FR-D2). */
  presets?: NameserverPreset[]
  /** FR-A4 — the account's saved contacts, for the other three roles. */
  profiles?: ProfileOption[]
}) {
  const id = useId()
  /** A nameserver choice that cannot work, caught before the order is tried. */
  const [hostProblem, setHostProblem] = useState<HostProblem | null>(null)
  const place = useAction(placeOrder, {
    onSuccess: ({ data }) => {
      if (data && 'redirectTo' in data) window.location.assign(data.redirectTo)
    },
  })
  const errors = place.result.validationErrors
  const data = place.result.data
  const failure = data && 'error' in data ? data : null
  const redirecting = Boolean(data && 'redirectTo' in data)
  // FR-D4 — seen once before paying; a changed choice is checked afresh.
  const hostWarnings = data && 'warnings' in data ? data.warnings : null

  return (
    <form
      aria-label="Checkout"
      noValidate
      className="grid gap-4 xl:grid-cols-[1.6fr_1fr]"
      onSubmit={onSubmitWith((form) => {
        const value = (name: string) => String(form.get(name) ?? '')
        const hosts = hostRequest(
          value,
          lines.map((line) => line.domain),
          presets,
        )
        if (!hosts.ok) {
          setHostProblem(hosts.problem)
          return
        }
        setHostProblem(null)
        const contacts = contactRolesFromForm(form)
        place.execute({
          registrant: registrantFromForm(form),
          ...hosts.input,
          ...(hostWarnings ? { hostWarningsSeen: true } : {}),
          confirmed: form.get('confirmed') === 'on' ? true : (false as unknown as true),
          expectedTotalKobo: summary.totalKobo,
          ...(contacts ? { contacts } : {}),
        })
      })}
    >
      <div className={cn(PANEL, 'space-y-10 p-5 sm:p-7')}>
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

          <div className="mt-6">
            <RegistrantFields
              idPrefix={id}
              registrant={registrant}
              errorFor={(name) => nestedError(errors, 'registrant', name)}
            />
          </div>

          <ContactRoles profiles={profiles} errors={errors} failure={failure} />
        </section>

        <NameserverChoice
          presets={presets}
          domains={lines.map((line) => line.domain)}
          problem={hostProblem ?? hostFailure(failure, errors)}
          onChange={() => {
            setHostProblem(null)
            if (hostWarnings) place.reset()
          }}
        />
      </div>

      <aside
        aria-labelledby={`${id}-review`}
        className={cn(PANEL, 'h-fit space-y-6 p-5 sm:p-7 xl:sticky xl:top-4')}
      >
        <h2 id={`${id}-review`} className="text-lg font-semibold text-foreground">
          Check and pay
        </h2>

        {/* FR-C6 — every name in large type, so a typo is caught while it is still free. */}
        <ul aria-label="Domains you are buying" className="space-y-4">
          {lines.map((line) => (
            <li key={line.domain}>
              <p className="text-xl font-bold tracking-tight break-all text-foreground">
                <DomainName name={line.domain} />
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

        {hostWarnings ? <HostWarnings warnings={hostWarnings} /> : null}
        {failure && !isHostFailure(failure) ? (
          <FormMessage tone="error">
            {failure.error}
            {failure.twoFactor ? (
              <>
                {' '}
                <Link
                  href={TWO_FACTOR_SETTINGS_HREF}
                  className="font-medium underline underline-offset-2"
                >
                  Turn on two-factor
                </Link>
              </>
            ) : null}
          </FormMessage>
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
          You pay on Flutterwave's secure page — card, bank transfer or USSD. {PROCESSING_FEE_NOTE}{' '}
          Before you are charged we check every name is still free.
        </p>
        {/* CMP-1 / CMP-2 — the agreement and the registrant's rights, at the point of purchase. */}
        <p className="text-pretty text-xs/5 text-muted-foreground">
          By paying you agree to the{' '}
          <Link href="/legal/registration-agreement" className="underline hover:text-foreground">
            registration agreement
          </Link>{' '}
          and{' '}
          <Link href="/legal/refunds" className="underline hover:text-foreground">
            refund policy
          </Link>
          . Your rights as a registrant are in the{' '}
          <Link href="/legal/registrant-rights" className="underline hover:text-foreground">
            Registrants&apos; Benefits and Responsibilities
          </Link>
          .
        </p>
      </aside>
    </form>
  )
}
