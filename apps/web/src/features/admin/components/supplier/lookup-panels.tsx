'use client'

import {
  ADMIN_PRICE_OPS,
  type AdminPriceCheck,
  type AdminPriceOp,
  type AdminRegistrantVerification,
  type AdminRegistryDomain,
  type AdminRegistryPage,
  type AdminRenewCheck,
  type AdminSslStatus,
  type AdminTransferState,
} from '@dr/shared/admin'
import { useEffect, useId, useRef, useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import {
  checkRenewable,
  checkSupplierPrice,
  lookupDomain,
  lookupSsl,
  readRegistrantVerification,
  readRegistryPage,
  readTransferState,
} from '@/features/admin/actions/supplier-live'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { type AdminResult, adminOutcome } from '@/features/admin/lib/errors'
import { formatUsd, formatWat, formatWatDate } from '@/features/admin/lib/format'
import { cn } from '@/lib/utils'

/**
 * The Lookup page's live reads (docs/ADMIN-SPEC.md §5.2 B6, D10, D22): each
 * a button a person presses, never a read on render. Every press writes an
 * audit note, and the gateway claims it before asking DomainNameAPI. Names
 * are sent in the request body, never in the page's address (N13).
 *
 * The fields are uncontrolled, read when a button is pressed (CLAUDE.md §15,
 * "Search inputs are uncontrolled on purpose"): what was typed before the
 * page hydrated, or filled by autofill, is what is sent. The fields have no
 * `name` and the buttons submit nothing, so nothing typed can reach the
 * address even before the script runs. `data-ready` marks a hydrated panel.
 */

type SafeAnswer<T> = Parameters<typeof adminOutcome<T>>[0]

/** True once this panel's script runs: before that, a press does nothing. */
function useReady() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return ready
}

/** One read's state: pending, its words on refusal, and its answer with the audit id. */
function useLiveRead<T>() {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ which: string; data: T; auditId: number } | null>(null)

  async function run(which: string, call: () => Promise<SafeAnswer<T>>) {
    if (pending) return
    setPending(which)
    setError(null)
    try {
      const outcome: AdminResult<T> = adminOutcome(await call())
      if (outcome.ok && outcome.data !== undefined) {
        setResult({ which, data: outcome.data, auditId: outcome.auditId })
      } else if (outcome.ok) {
        setError('DomainNameAPI had nothing to say about that.')
        setResult(null)
      } else {
        setError(outcome.message)
        setResult(null)
      }
    } catch {
      setError("We couldn't reach the dashboard's server. Try again.")
      setResult(null)
    } finally {
      setPending(null)
    }
  }

  /** A read refused before anything is sent: nothing typed, or not a name. */
  function refuse(message: string) {
    setError(message)
    setResult(null)
  }
  return { pending, error, result, run, refuse }
}

function ReadButton({
  label,
  which,
  pending,
  disabled,
  onClick,
}: {
  label: string
  which: string
  pending: string | null
  disabled?: boolean
  onClick: () => void
}) {
  const busy = pending === which
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={Boolean(pending) || disabled}
      aria-busy={busy || undefined}
      className={QUIET_BUTTON}
    >
      {busy ? <Spinner className="size-4" aria-hidden="true" /> : null}
      {label}
    </button>
  )
}

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? '—' : value ? 'On' : 'Off'

function Result({ auditId, readAt, items }: { auditId: number; readAt: string; items: DlItem[] }) {
  return (
    <div role="status" className="rounded-2xl border border-border bg-background/70 p-4">
      <DlGrid items={items} />
      <p className="mt-3 text-xs text-muted-foreground">
        Read {formatWat(readAt)} · audit entry #{auditId}
      </p>
    </div>
  )
}

type DomainAnswer =
  | AdminRegistryDomain
  | AdminTransferState
  | AdminRenewCheck
  | AdminRegistrantVerification

const TRANSFER_WORDS: Record<AdminTransferState['state'], string> = {
  pending: 'Waiting at the registry',
  completed: 'Completed: the domain moved to us',
  rejected: 'Refused by the registry or the losing registrar',
  cancelled: 'Cancelled',
  unknown: 'A status we do not recognise',
}

function domainItems(which: string, data: DomainAnswer): DlItem[] {
  if (which === 'lookup') {
    const d = data as AdminRegistryDomain
    if (d.outcome === 'not_found') {
      return [
        { label: 'Domain', value: d.name },
        { label: 'At the registry', value: 'Not in our DomainNameAPI account on this side' },
      ]
    }
    return [
      { label: 'Domain', value: d.name },
      { label: 'Status', value: d.status ?? '—' },
      { label: 'Expires', value: formatWatDate(d.expiresAt) },
      { label: 'Redemption ends', value: formatWatDate(d.rgpExpiresAt) },
      { label: 'Transfer lock', value: yesNo(d.transferLock) },
      { label: 'Privacy', value: yesNo(d.privacy) },
      {
        label: 'Nameservers',
        value: d.nameservers.length > 0 ? d.nameservers.join(', ') : '—',
        wide: true,
      },
    ]
  }
  if (which === 'transfer') {
    const t = data as AdminTransferState
    return [
      { label: 'Domain', value: t.name },
      {
        label: 'Transfer',
        value: <AdminStatusPill value={t.state} labels={TRANSFER_WORDS} />,
      },
      { label: 'Requested', value: formatWat(t.requestedAt) },
      { label: 'Decided', value: formatWat(t.finalAt) },
      { label: "DomainNameAPI's word", value: t.supplierStatus ?? '—' },
    ]
  }
  if (which === 'renew') {
    const r = data as AdminRenewCheck
    return [
      { label: 'Domain', value: r.name },
      { label: 'Renewable', value: r.renewable ? 'Yes' : 'No' },
      { label: 'Renewal lock', value: r.renewalLock ? 'On' : 'Off' },
      ...(r.reasonKey
        ? [{ label: 'Why not', value: r.reasonKey.replace(/_/g, ' ').toLowerCase() }]
        : []),
    ]
  }
  const v = data as AdminRegistrantVerification
  return [
    { label: 'Domain', value: v.name },
    { label: 'Registrant verified', value: v.isVerified ? 'Yes' : 'Not yet' },
    { label: 'Verified', value: formatWat(v.verifiedAt) },
    { label: 'What was verified', value: v.fieldType ?? '—' },
  ]
}

/** The text in an uncontrolled field, trimmed. */
const textOf = (ref: React.RefObject<HTMLInputElement | HTMLSelectElement | null>) =>
  (ref.current?.value ?? '').trim()

/** Enter in a field runs the panel's first read, as a form would. */
const onEnter = (run: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    run()
  }
}

const NAME_NEEDED = 'Enter a domain name, such as example.com.'

/** One domain at the registry: its record, a transfer's state, renewability, verification. */
export function DomainLookup({ renewCheckEnabled }: { renewCheckEnabled: boolean }) {
  const id = useId()
  const ready = useReady()
  const nameRef = useRef<HTMLInputElement>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const yearsRef = useRef<HTMLSelectElement>(null)
  const read = useLiveRead<DomainAnswer | null>()

  /** The name and reason as typed now, or a refusal before anything is sent. */
  function start(
    which: string,
    call: (name: string, reason: string | undefined) => Promise<SafeAnswer<DomainAnswer | null>>,
  ) {
    const name = textOf(nameRef)
    if (name.length < 3) return read.refuse(NAME_NEEDED)
    const reason = textOf(reasonRef) || undefined
    return read.run(which, () => call(name, reason))
  }
  const lookup = () => start('lookup', (name, reason) => lookupDomain({ name, reason }))

  return (
    <div className="space-y-4" data-ready={ready ? 'true' : undefined}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-name`} className="text-sm font-medium text-foreground">
            Domain name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            onKeyDown={onEnter(lookup)}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            placeholder="example.com"
            className={cn(inputClass, 'mt-1.5')}
          />
        </div>
        <div>
          <label htmlFor={`${id}-reason`} className="text-sm font-medium text-foreground">
            Why (optional)
          </label>
          <input
            id={`${id}-reason`}
            ref={reasonRef}
            onKeyDown={onEnter(lookup)}
            maxLength={500}
            autoComplete="off"
            aria-describedby={`${id}-reason-hint`}
            className={cn(inputClass, 'mt-1.5')}
          />
          <p id={`${id}-reason-hint`} className="mt-1.5 text-xs text-muted-foreground">
            Kept in the audit log. Don't include personal details.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <ReadButton
          label="Read the registry now"
          which="lookup"
          pending={read.pending}
          onClick={lookup}
        />
        <ReadButton
          label="Read the transfer state"
          which="transfer"
          pending={read.pending}
          onClick={() => start('transfer', (name, reason) => readTransferState({ name, reason }))}
        />
        <ReadButton
          label="Registrant verification"
          which="verification"
          pending={read.pending}
          onClick={() =>
            start('verification', (name, reason) => readRegistrantVerification({ name, reason }))
          }
        />
        {renewCheckEnabled ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Years
              <select
                ref={yearsRef}
                defaultValue="1"
                className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <ReadButton
              label="Check renewability"
              which="renew"
              pending={read.pending}
              onClick={() =>
                start('renew', (name, reason) =>
                  checkRenewable({ name, years: Number(textOf(yearsRef) || 1), reason }),
                )
              }
            />
          </div>
        ) : null}
      </div>
      <ActionError message={read.error} returnTo="/admin/supplier/lookup" />
      {read.result ? (
        read.result.data === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            The registry lists no registrant for this domain in our account. Audit entry #
            {read.result.auditId}
          </p>
        ) : (
          <Result
            auditId={read.result.auditId}
            readAt={read.result.data.readAt}
            items={domainItems(read.result.which, read.result.data)}
          />
        )
      ) : null}
    </div>
  )
}

/** A certificate's status at the supplier, by its name; a wildcard keeps its `*.`. */
export function SslLookup() {
  const id = useId()
  const ready = useReady()
  const nameRef = useRef<HTMLInputElement>(null)
  const read = useLiveRead<AdminSslStatus>()
  const lookup = () => {
    const name = textOf(nameRef)
    if (name.length < 3) return read.refuse('Enter a certificate name, such as example.com.')
    return read.run('ssl', () => lookupSsl({ name }))
  }
  return (
    <div className="space-y-4" data-ready={ready ? 'true' : undefined}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <label htmlFor={`${id}-name`} className="text-sm font-medium text-foreground">
            Certificate name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            onKeyDown={onEnter(lookup)}
            autoComplete="off"
            spellCheck={false}
            placeholder="example.com or *.example.com"
            className={cn(inputClass, 'mt-1.5')}
          />
        </div>
        <ReadButton
          label="Read the certificate"
          which="ssl"
          pending={read.pending}
          onClick={lookup}
        />
      </div>
      <ActionError message={read.error} returnTo="/admin/supplier/lookup" />
      {read.result ? (
        <Result
          auditId={read.result.auditId}
          readAt={read.result.data.readAt}
          items={
            read.result.data.outcome === 'not_found'
              ? [
                  { label: 'Certificate', value: read.result.data.name },
                  { label: 'At DomainNameAPI', value: 'No certificate by this name on this side' },
                ]
              : [
                  { label: 'Certificate', value: read.result.data.name },
                  { label: 'Status', value: read.result.data.status ?? '—' },
                  { label: 'Set up', value: yesNo(read.result.data.isConfigured) },
                  { label: 'Issued', value: yesNo(read.result.data.isIssued) },
                  {
                    label: 'Certificate expires',
                    value: formatWatDate(read.result.data.certificateExpiresAt),
                  },
                  {
                    label: 'Subscription ends',
                    value: formatWatDate(read.result.data.subscriptionEndsAt),
                  },
                ]
          }
        />
      ) : null}
    </div>
  )
}

const OP_WORDS: Record<AdminPriceOp, string> = {
  register: 'Register',
  renew: 'Renew',
  transfer: 'Transfer in',
  restore: 'Restore',
}

const isOp = (value: string): value is AdminPriceOp =>
  (ADMIN_PRICE_OPS as readonly string[]).includes(value)

/** The supplier's price for one operation, against the cost we price from (D13). */
export function PriceCheck() {
  const id = useId()
  const ready = useReady()
  const tldRef = useRef<HTMLInputElement>(null)
  const opRef = useRef<HTMLSelectElement>(null)
  const yearsRef = useRef<HTMLSelectElement>(null)
  const read = useLiveRead<AdminPriceCheck>()
  const check = () => {
    const tld = textOf(tldRef)
    if (tld.replace(/^\./, '').length < 2) return read.refuse('Enter an extension, such as com.')
    const typed = textOf(opRef)
    const op: AdminPriceOp = isOp(typed) ? typed : 'register'
    const years = Number(textOf(yearsRef) || 1)
    return read.run('price', () => checkSupplierPrice({ tld, op, years }))
  }
  return (
    <div className="space-y-4" data-ready={ready ? 'true' : undefined}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 sm:w-48">
          <label htmlFor={`${id}-tld`} className="text-sm font-medium text-foreground">
            Extension
          </label>
          <input
            id={`${id}-tld`}
            ref={tldRef}
            onKeyDown={onEnter(check)}
            autoComplete="off"
            spellCheck={false}
            placeholder="com"
            className={cn(inputClass, 'mt-1.5')}
          />
        </div>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Operation
          <select
            ref={opRef}
            defaultValue="register"
            className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
          >
            {ADMIN_PRICE_OPS.map((value) => (
              <option key={value} value={value}>
                {OP_WORDS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Years
          <select
            ref={yearsRef}
            defaultValue="1"
            className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
          >
            {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <ReadButton label="Check the price" which="price" pending={read.pending} onClick={check} />
      </div>
      <ActionError message={read.error} returnTo="/admin/supplier/lookup" />
      {read.result ? (
        <Result
          auditId={read.result.auditId}
          readAt={read.result.data.readAt}
          items={[
            { label: 'Extension', value: `.${read.result.data.tld}` },
            {
              label: 'Operation',
              value: `${OP_WORDS[read.result.data.op]}, ${read.result.data.years} ${read.result.data.years === 1 ? 'year' : 'years'}`,
            },
            { label: "DomainNameAPI's price", value: formatUsd(read.result.data.supplierCents) },
            {
              label: 'Our cost basis',
              value:
                read.result.data.ourCents === null
                  ? 'Not priced'
                  : formatUsd(read.result.data.ourCents),
            },
            {
              label: 'Matches',
              value: (
                <AdminStatusPill
                  value={read.result.data.matches ? 'ok' : 'warning'}
                  labels={{ ok: 'Matches', warning: 'Differs' }}
                />
              ),
            },
          ]}
        />
      ) : null}
    </div>
  )
}

const PAGE = 25

/** Our account's domains at the registry, a page at a time. */
export function RegistryListing() {
  const read = useLiveRead<AdminRegistryPage>()
  const [skip, setSkip] = useState(0)
  const page = read.result?.data
  const load = (at: number) =>
    read.run('page', async () => {
      const answer = await readRegistryPage({ skip: at, take: PAGE })
      setSkip(at)
      return answer
    })
  return (
    <div className="space-y-4">
      <ReadButton
        label={page ? 'Read the listing again' : 'Read the listing'}
        which="page"
        pending={read.pending}
        onClick={() => load(page ? skip : 0)}
      />
      <ActionError message={read.error} returnTo="/admin/supplier/lookup" />
      {page && read.result ? (
        <div role="status" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {page.total === 0
              ? 'No domains in our DomainNameAPI account on this side.'
              : `${page.total} ${page.total === 1 ? 'domain' : 'domains'} on the ${page.side} side; showing ${skip + 1}–${skip + page.items.length}.`}{' '}
            Read {formatWat(page.readAt)} · audit entry #{read.result.auditId}
          </p>
          {page.items.length > 0 ? (
            <ul className="space-y-2">
              {page.items.map((item) => (
                <li
                  key={item.name}
                  className="rounded-2xl border border-border bg-background/70 p-3 text-sm"
                >
                  <p className="font-medium break-all text-foreground">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.status ?? 'No status'} · expires {formatWatDate(item.expiresAt)} · lock{' '}
                    {yesNo(item.transferLock).toLowerCase()} · privacy{' '}
                    {yesNo(item.privacy).toLowerCase()}
                    {item.renewalModeLabel ? ` · renewal mode "${item.renewalModeLabel}"` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {page.total > PAGE ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(read.pending) || skip === 0}
                onClick={() => load(Math.max(0, skip - PAGE))}
                className={QUIET_BUTTON}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={Boolean(read.pending) || skip + PAGE >= page.total}
                onClick={() => load(skip + PAGE)}
                className={QUIET_BUTTON}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
