'use client'

import { ExternalLink, Zap } from 'lucide-react'
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
import { StatusPill } from '@/components/common/status-pill'
import { Spinner } from '@/components/ui/spinner'
import { addRecordsWithCloudflareToken, startCloudflareConnect } from '../actions/dns-setup'
import { cloudflareTokenPage, type RecordResult } from '../lib/cloudflare'
import { OUTCOME_LABEL, OUTCOME_WORDS } from '../lib/dns-setup'
import type { DnsRecord } from '../lib/records'
import { recordTitle } from './records-table'

/**
 * "Add to Cloudflare" (MAIL-SPEC §5.3), shown when public DNS says the
 * domain's zone is on Cloudflare. One click through Domain Connect once
 * Cloudflare has our template (`oneClick`); until then, or if the customer
 * prefers, a token they create from a prefilled Cloudflare page and paste
 * once — used for this run and never kept. Owners, admins and developers
 * only, as for every DNS change; anyone else is told who can.
 */

const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70'
const textButton =
  'inline-flex min-h-11 items-center rounded-full text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:opacity-70 disabled:cursor-not-allowed disabled:opacity-60'

export function CloudflareSetup({
  accountId,
  domainId,
  zone,
  oneClick,
  canManage,
  records,
}: {
  accountId: string
  domainId: string
  zone: string
  oneClick: boolean
  canManage: boolean
  records: DnsRecord[]
}) {
  const [showToken, setShowToken] = useState(!oneClick)
  const formId = useId()

  return (
    <section
      aria-labelledby="cloudflare-heading"
      className="rounded-3xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-full bg-muted p-2" aria-hidden="true">
          <Zap className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="cloudflare-heading" className="font-semibold">
            Add them to Cloudflare for you
          </h2>
          <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">
            {zone}’s DNS is on Cloudflare.{' '}
            {canManage
              ? 'We can add the records below there, with no copying. Nothing already in your DNS is changed or removed.'
              : 'An owner, admin or developer of this account can add the records below there from this page.'}
          </p>
        </div>
      </div>

      {canManage ? (
        <div className="mt-5 space-y-4">
          {oneClick ? <OneClick accountId={accountId} domainId={domainId} /> : null}
          {oneClick ? (
            <button
              type="button"
              className={textButton}
              aria-expanded={showToken}
              aria-controls={formId}
              onClick={() => setShowToken((open) => !open)}
            >
              {showToken ? 'Hide the API token way' : 'Use a Cloudflare API token instead'}
            </button>
          ) : null}
          <div id={formId} hidden={!showToken}>
            <TokenForm accountId={accountId} domainId={domainId} zone={zone} records={records} />
          </div>
        </div>
      ) : null}
    </section>
  )
}

function OneClick({ accountId, domainId }: { accountId: string; domainId: string }) {
  const [leaving, setLeaving] = useState(false)
  const connect = useAction(startCloudflareConnect, {
    onSuccess: ({ data }) => {
      if (data && 'url' in data) {
        setLeaving(true)
        window.location.assign(data.url)
      }
    },
  })
  const data = connect.result.data
  const error = (data && 'error' in data ? data.error : null) ?? connect.result.serverError ?? null
  const pending = connect.isPending || leaving
  return (
    <div className="space-y-3">
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <button
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => connect.execute({ accountId, domainId })}
        className={primaryButton}
      >
        {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
        {pending ? 'Opening Cloudflare…' : 'Add records in Cloudflare'}
      </button>
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Cloudflare asks you to sign in, shows the records it will add, and brings you back here when
        you approve.
      </p>
    </div>
  )
}

function TokenForm({
  accountId,
  domainId,
  zone,
  records,
}: {
  accountId: string
  domainId: string
  zone: string
  records: DnsRecord[]
}) {
  const id = useId()
  const add = useAction(addRecordsWithCloudflareToken, {
    onSuccess: ({ data }) => {
      if (data && 'results' in data) {
        const input = document.getElementById(`${id}-token`) as HTMLInputElement | null
        if (input) input.value = ''
      }
    },
  })
  const data = add.result.data
  const error = (data && 'error' in data ? data.error : null) ?? add.result.serverError ?? null
  const tokenError = fieldError(add.result.validationErrors, 'token')
  const hint = 'We use it once to add these records, then forget it. It is never stored.'
  const done = data && 'results' in data ? data : null

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-pretty text-sm/6">
        <li>
          <a
            href={cloudflareTokenPage()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Create a token in Cloudflare
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          . Its permissions are filled in for you: Zone Read and DNS Edit.
        </li>
        <li>
          Under Zone Resources, pick <span className="font-medium break-all">{zone}</span>. Then
          select Continue to summary, then Create Token.
        </li>
        <li>Copy the token Cloudflare shows, and paste it here.</li>
      </ol>
      <form
        aria-label="Add records to Cloudflare"
        className="space-y-3"
        noValidate
        onSubmit={onSubmitWith((form) =>
          add.execute({ accountId, domainId, token: String(form.get('token') ?? '') }),
        )}
      >
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Field id={`${id}-token`} label="Cloudflare API token" error={tokenError} hint={hint}>
          <input
            id={`${id}-token`}
            name="token"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={tokenError ? true : undefined}
            aria-describedby={describedBy(`${id}-token`, tokenError, hint)}
            className={inputClass}
          />
        </Field>
        {/* Executing, not pending: the page's refresh after the answer is no reason to wait. */}
        <SubmitButton
          pending={add.isExecuting}
          pendingLabel="Adding records…"
          className="sm:w-auto"
        >
          Add the records
        </SubmitButton>
      </form>
      {done ? (
        <Results zone={done.zone} results={done.results} stopped={done.stopped} records={records} />
      ) : null}
    </div>
  )
}

function Results({
  zone,
  results,
  stopped,
  records,
}: {
  zone: string
  results: RecordResult[]
  stopped: string | null
  records: DnsRecord[]
}) {
  const changed = results.filter((r) => r.outcome === 'added' || r.outcome === 'updated').length
  return (
    <div role="status" className="space-y-3">
      <p className="text-pretty text-sm/6 font-medium">
        {changed > 0
          ? `Done in ${zone}: ${changed} ${changed === 1 ? 'record' : 'records'} added or fixed.`
          : `Nothing needed adding in ${zone}.`}{' '}
        <span className="font-normal text-muted-foreground">
          We did not keep the token; you can delete it in Cloudflare (My Profile → API Tokens).
          Amazon SES usually sees new records within minutes: use Check now above.
        </span>
      </p>
      {stopped ? <FormMessage tone="error">{stopped}</FormMessage> : null}
      <ul className="space-y-2" aria-label="What was done in Cloudflare">
        {results.map((result) => {
          const record = records.find((r) => r.id === result.id)
          const { label, tone } = OUTCOME_LABEL[result.outcome]
          const words = OUTCOME_WORDS[result.outcome]
          return (
            <li key={result.id} className="rounded-2xl border border-border px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {record ? recordTitle(record, records) : result.id}
                </span>
                <StatusPill tone={tone}>{label}</StatusPill>
              </div>
              {words ? (
                <p className="mt-1 text-pretty text-xs/5 text-muted-foreground">{words}</p>
              ) : null}
              {result.seen.length > 0 ? (
                <p className="mt-1 text-xs/5 text-muted-foreground">
                  In Cloudflare now:{' '}
                  <span className="font-mono break-all">{result.seen.join(', ')}</span>
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
