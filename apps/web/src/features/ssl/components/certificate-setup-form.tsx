'use client'

import { KeyRound, RefreshCw, TriangleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useEffect, useId, useState } from 'react'
import {
  Field,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { RegistrantFields } from '@/features/checkout/components/registrant-fields'
import { type RegistrantForm, registrantFromForm } from '@/features/checkout/lib/contact'
import { COUNTRY_NAMES, REGISTRANT_COUNTRIES } from '@/features/checkout/lib/countries'
import { cn } from '@/lib/utils'
import {
  checkCertificateRequest,
  generateCertificateRequest,
  loadApprovers,
  requestCertificateSetup,
} from '../actions/setup'
import { csrFileName, keyFileName } from '../lib/files'
import { TextFile } from './text-file'

/**
 * FR-SSL-4: the customer's set-up — the request (their own CSR, or one we
 * have the supplier make), who approves it, their server and the contact the
 * CA records. Sent once, through the queue; the page then shows the approval.
 *
 * A key made for them is shown here once and kept nowhere: it lives in this
 * component's state, which is cleared when the page is left (Next keeps a
 * left page in the DOM, so the cleanup matters — as for transfer codes).
 */

type Props = {
  certificateId: string
  /** The supplier name: example.com, or *.example.com. */
  commonName: string
  isWildcard: boolean
  includedNames: number
  contact: RegistrantForm
  /** A refused earlier set-up, in words, to fix. */
  problem: string | null
}

// A floated legend no longer sits in the fieldset's top border (which drew a
// rule beside the heading); the first thing after it clears it.
const SECTION =
  'space-y-4 border-border border-t pt-6 first:border-t-0 first:pt-0 [&>legend+*]:clear-both'
const LEGEND = 'float-left w-full text-base font-semibold text-foreground'
const SMALL_BUTTON = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
  FOCUS,
)

function contactError(errors: unknown, name: string): string | undefined {
  const node = (errors as Record<string, Record<string, { _errors?: string[] }>> | undefined)
    ?.contact?.[name]
  return node?._errors?.[0]
}

export function CertificateSetupForm({
  certificateId,
  commonName,
  isWildcard,
  includedNames,
  contact,
  problem,
}: Props) {
  const id = useId()
  const router = useRouter()
  const multi = includedNames > 1
  const [mode, setMode] = useState<'own' | 'generate'>('own')
  const [csr, setCsr] = useState('')
  // The generated private key: here and nowhere else, and gone with the page.
  const [privateKey, setPrivateKey] = useState<string | null>(null)
  const [keySaved, setKeySaved] = useState(false)
  const [extraNames, setExtraNames] = useState('')
  const [approver, setApprover] = useState('')

  useEffect(
    () => () => {
      setPrivateKey(null)
      setCsr('')
    },
    [],
  )

  const approvers = useAction(loadApprovers)
  const check = useAction(checkCertificateRequest)
  const generate = useAction(generateCertificateRequest, {
    onSuccess: ({ data }) => {
      if (data && 'csr' in data) {
        setCsr(data.csr)
        setPrivateKey(data.privateKey)
        setKeySaved(false)
      }
    },
  })
  const setup = useAction(requestCertificateSetup, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setPrivateKey(null)
        router.refresh()
      }
    },
  })

  const { execute: fetchApprovers } = approvers
  useEffect(() => {
    fetchApprovers({ certificateId })
  }, [fetchApprovers, certificateId])

  const emails =
    approvers.result.data && 'emails' in approvers.result.data ? approvers.result.data.emails : null
  const approversError =
    (approvers.result.data && 'error' in approvers.result.data
      ? approvers.result.data.error
      : null) ?? (approvers.result.serverError ? 'We could not load the approval addresses.' : null)

  const checked =
    check.result.data && 'summary' in check.result.data ? check.result.data.summary : null
  const checkError =
    check.result.data && 'error' in check.result.data ? check.result.data.error : null
  const generateError =
    generate.result.data && 'error' in generate.result.data ? generate.result.data.error : null
  const failure = setup.result.data && 'error' in setup.result.data ? setup.result.data : null
  const errors = setup.result.validationErrors
  const names = () =>
    extraNames
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter(Boolean)

  return (
    <form
      aria-label="Set up the certificate"
      noValidate
      className="space-y-8"
      onSubmit={onSubmitWith((form) => {
        // A generated key must be saved before the request it belongs to is sent.
        if (mode === 'generate' && (!privateKey || !keySaved)) return
        setup.execute({
          certificateId,
          csr,
          approverEmail: approver,
          webServer: String(form.get('webServer') ?? 'apache') as 'apache' | 'iis',
          extraNames: multi ? names() : [],
          contact: registrantFromForm(form, 'contact-'),
        })
      })}
    >
      {problem ? (
        <FormMessage tone="error">
          <span className="font-medium">The last set-up was not accepted.</span> {problem}
        </FormMessage>
      ) : null}

      <fieldset className={SECTION}>
        <legend className={LEGEND}>1. The certificate request (CSR)</legend>
        <p className="text-pretty text-sm/6 text-muted-foreground">
          A CSR tells the certificate authority the name —{' '}
          <span className="font-mono">{commonName}</span> — and carries the public half of a key.
          The private half stays with whoever made it, and your server needs it to use the
          certificate.
        </p>
        <div
          role="radiogroup"
          aria-label="Where the request comes from"
          className="grid gap-3 sm:grid-cols-2"
        >
          {(
            [
              [
                'own',
                'I have a CSR',
                'Made on your server or by your host — the safest way: your key never leaves it.',
              ],
              [
                'generate',
                'Make one for me',
                'Our supplier makes a key and CSR, and we show you the key once.',
              ],
            ] as const
          ).map(([value, title, body]) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-2xl border p-4 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                mode === value ? 'border-ring bg-brand-subtle' : 'border-border hover:bg-muted/60',
              )}
            >
              <input
                type="radio"
                name="csrMode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value)
                  if (value === 'own') setPrivateKey(null)
                  setCsr('')
                }}
                className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                <span className="block font-medium text-foreground">{title}</span>
                <span className="mt-0.5 block text-muted-foreground">{body}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'own' ? (
          <div className="space-y-3">
            <Field
              id={`${id}-csr`}
              label="Paste the CSR"
              error={failure?.field === 'csr' ? failure.error : (checkError ?? undefined)}
              hint="Everything from -----BEGIN CERTIFICATE REQUEST----- to -----END CERTIFICATE REQUEST-----. Never paste the private key."
            >
              <textarea
                id={`${id}-csr`}
                name="csr"
                rows={8}
                spellCheck={false}
                value={csr}
                onChange={(event) => setCsr(event.target.value)}
                aria-invalid={failure?.field === 'csr' || checkError ? true : undefined}
                aria-describedby={
                  failure?.field === 'csr' || checkError ? `${id}-csr-error` : `${id}-csr-hint`
                }
                className={cn(inputClass, 'h-auto py-3 font-mono text-xs/5')}
              />
            </Field>
            <button
              type="button"
              className={SMALL_BUTTON}
              disabled={check.isPending || csr.trim() === ''}
              onClick={() => check.execute({ certificateId, csr })}
            >
              {check.isPending ? 'Checking…' : 'Check it'}
            </button>
            {checked ? (
              <FormMessage tone="success">
                The CA reads this request as being for{' '}
                <span className="font-mono">{checked.commonName}</span>
                {checked.organization ? `, ${checked.organization}` : ''}.
              </FormMessage>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {privateKey ? (
              <div className="space-y-4 rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
                <p className="flex gap-2 text-pretty text-sm/6 text-foreground">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium">Save this private key now.</span> It is shown
                    once: we do not keep it, and nobody can show it to you again. Without it the
                    certificate cannot be installed — you would have to set it up again with a new
                    one. Keep it secret: anyone with it can pretend to be your site.
                  </span>
                </p>
                <TextFile
                  label="Your private key"
                  fileName={keyFileName(commonName)}
                  content={privateKey}
                />
                <TextFile
                  label="The request (CSR) that goes with it"
                  fileName={csrFileName(commonName)}
                  content={csr}
                  rows={5}
                />
                <label className="flex cursor-pointer items-start gap-3 text-sm/6">
                  <input
                    type="checkbox"
                    checked={keySaved}
                    onChange={(event) => setKeySaved(event.target.checked)}
                    className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="text-foreground">
                    I have saved the private key somewhere safe.
                  </span>
                </label>
              </div>
            ) : (
              <>
                <p className="text-pretty text-sm/6 text-muted-foreground">
                  The key is made by our supplier, DomainNameAPI, and passes through our server to
                  your browser. We do not store or log it. If nobody else should ever see your key,
                  make the CSR on your own server instead.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={`${id}-organization`} label="Organisation (or your name)">
                    <input
                      id={`${id}-organization`}
                      name="organization"
                      className={inputClass}
                      autoComplete="organization"
                      defaultValue={
                        contact.company || `${contact.firstName} ${contact.lastName}`.trim()
                      }
                    />
                  </Field>
                  <Field id={`${id}-unit`} label="Department (optional)">
                    <input id={`${id}-unit`} name="organizationUnit" className={inputClass} />
                  </Field>
                  <Field id={`${id}-locality`} label="City">
                    <input
                      id={`${id}-locality`}
                      name="locality"
                      className={inputClass}
                      autoComplete="address-level2"
                      defaultValue={contact.city}
                    />
                  </Field>
                  <Field id={`${id}-region`} label="State">
                    <input
                      id={`${id}-region`}
                      name="region"
                      className={inputClass}
                      autoComplete="address-level1"
                      defaultValue={contact.state}
                    />
                  </Field>
                  <Field id={`${id}-csr-country`} label="Country">
                    <select
                      id={`${id}-csr-country`}
                      name="csrCountry"
                      defaultValue={contact.country || 'NG'}
                      className={inputClass}
                    >
                      {REGISTRANT_COUNTRIES.map((code) => (
                        <option key={code} value={code}>
                          {COUNTRY_NAMES[code]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={generate.isPending}
                  onClick={(event) => {
                    const form = new FormData(event.currentTarget.form ?? undefined)
                    const value = (name: string) => String(form.get(name) ?? '').trim()
                    generate.execute({
                      certificateId,
                      organization: value('organization'),
                      organizationUnit: value('organizationUnit'),
                      locality: value('locality'),
                      state: value('region'),
                      country: value('csrCountry'),
                      extraNames: multi ? names() : [],
                    })
                  }}
                >
                  <KeyRound className="size-4" aria-hidden="true" />
                  {generate.isPending ? 'Making your key…' : 'Make my key and CSR'}
                </button>
                {generateError ? <FormMessage tone="error">{generateError}</FormMessage> : null}
              </>
            )}
          </div>
        )}
      </fieldset>

      {multi ? (
        <fieldset className={SECTION}>
          <legend className={LEGEND}>2. The other names</legend>
          <Field
            id={`${id}-names`}
            label={`Up to ${includedNames - 1} more names, one per line`}
            error={failure?.field === 'extraNames' ? failure.error : undefined}
            hint={`Each must be ${commonName.replace(/^www\./, '')} or end in .${commonName.replace(/^www\./, '')}, so one approval covers them all.`}
          >
            <textarea
              id={`${id}-names`}
              name="extraNames"
              rows={4}
              value={extraNames}
              onChange={(event) => setExtraNames(event.target.value)}
              aria-invalid={failure?.field === 'extraNames' ? true : undefined}
              aria-describedby={
                failure?.field === 'extraNames' ? `${id}-names-error` : `${id}-names-hint`
              }
              className={cn(inputClass, 'h-auto py-3 font-mono text-sm')}
            />
          </Field>
        </fieldset>
      ) : null}

      <fieldset className={SECTION}>
        <legend className={LEGEND}>{multi ? '3' : '2'}. Who approves it</legend>
        <p className="text-pretty text-sm/6 text-muted-foreground">
          The certificate authority emails this address to confirm you control{' '}
          {isWildcard ? commonName.slice(2) : commonName}. Choose one you can read — if none of them
          reaches you yet, set one up with your email host first.
        </p>
        {approvers.isPending || (!emails && !approversError) ? (
          <div aria-hidden="true" className="grid animate-pulse gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="h-11 rounded-xl bg-muted" />
            ))}
          </div>
        ) : approversError ? (
          <div className="space-y-3">
            <FormMessage tone="error">{approversError}</FormMessage>
            <button
              type="button"
              className={SMALL_BUTTON}
              onClick={() => fetchApprovers({ certificateId })}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Approval address" className="grid gap-2">
            {(emails ?? []).map((email) => (
              <label
                key={email}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                  approver === email
                    ? 'border-ring bg-brand-subtle'
                    : 'border-border hover:bg-muted/60',
                )}
              >
                <input
                  type="radio"
                  name="approverEmail"
                  value={email}
                  checked={approver === email}
                  onChange={() => setApprover(email)}
                  className="size-4 shrink-0 accent-[var(--accent)]"
                />
                <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere] text-foreground sm:text-sm">
                  {email}
                </span>
              </label>
            ))}
          </div>
        )}
        {failure?.field === 'approverEmail' ? (
          <p className="text-sm text-destructive">{failure.error}</p>
        ) : (
          fieldErrorText(errors, 'approverEmail')
        )}
      </fieldset>

      <fieldset className={SECTION}>
        <legend className={LEGEND}>{multi ? '4' : '3'}. Your server</legend>
        <Field
          id={`${id}-server`}
          label="Where it will be installed"
          hint="The supplier asks for one of these two. The certificate you download is the same text either way."
        >
          <select
            id={`${id}-server`}
            name="webServer"
            defaultValue="apache"
            className={inputClass}
            aria-describedby={`${id}-server-hint`}
          >
            <option value="apache">Apache, Nginx, cPanel or another non-Microsoft server</option>
            <option value="iis">Microsoft IIS</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className={SECTION}>
        <legend className={LEGEND}>{multi ? '5' : '4'}. Contact for the certificate</legend>
        <p className="text-pretty text-sm/6 text-muted-foreground">
          The certificate authority and our supplier keep this contact with the certificate. City
          and state up to 20 characters, postcode up to 10.
        </p>
        <RegistrantFields
          idPrefix={`${id}-contact`}
          namePrefix="contact-"
          registrant={contact}
          errorFor={(name) =>
            failure?.field === `contact.${name}` ? failure.error : contactError(errors, name)
          }
        />
      </fieldset>

      {failure && !failure.field ? <FormMessage tone="error">{failure.error}</FormMessage> : null}
      {setup.result.serverError ? (
        <FormMessage tone="error">{setup.result.serverError}</FormMessage>
      ) : null}

      <div className="space-y-3 border-border border-t pt-6">
        <SubmitButton pending={setup.isPending} pendingLabel="Sending…" className="sm:w-auto">
          Send to the certificate authority
        </SubmitButton>
        {mode === 'generate' && privateKey && !keySaved ? (
          <p className="text-sm text-muted-foreground">Tick that you have saved the key first.</p>
        ) : null}
        {mode === 'generate' && !privateKey ? (
          <p className="text-sm text-muted-foreground">Make your key and CSR first.</p>
        ) : null}
      </div>
    </form>
  )
}

function fieldErrorText(errors: unknown, field: string) {
  const message = (errors as Record<string, { _errors?: string[] }> | undefined)?.[field]
    ?._errors?.[0]
  return message ? <p className="text-sm text-destructive">{message}</p> : null
}
