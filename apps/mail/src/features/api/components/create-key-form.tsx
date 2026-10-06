'use client'

import type { ApiKeyPermission } from '@dr/shared/mail'
import { Check, Copy } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
import type { MemberRole } from '@/lib/safe-action'
import { cn } from '@/lib/utils'
import { createApiKey, type NewKey } from '../actions/keys'
import { PERMISSION_LABEL, PERMISSION_SUMMARY, permissionsFor } from '../lib/keys'
import type { KeyDomain } from '../queries/keys'

/**
 * Making a key (MAIL-SPEC MR7): a name, what it may do, and — for a sending
 * key — one domain it is limited to. The key comes back once and is held
 * only in this component's state: gone once "I have saved it" and Done are
 * pressed, or the page is left.
 */
export function CreateKeyForm({
  accountId,
  memberRole,
  domains,
}: {
  accountId: string
  memberRole: MemberRole
  domains: KeyDomain[]
}) {
  const id = useId()
  const create = useAction(createApiKey)
  const allowed = permissionsFor(memberRole)
  const [permission, setPermission] = useState<ApiKeyPermission>('sending')
  const data = create.result.data
  const errors = create.result.validationErrors

  if (data && 'key' in data) return <NewKeyPanel created={data} onDone={() => create.reset()} />

  return (
    <form
      aria-label="Make an API key"
      className="space-y-5"
      noValidate
      onSubmit={onSubmitWith((form) =>
        create.execute({
          accountId,
          name: String(form.get('name') ?? ''),
          permission,
          domainId: permission === 'sending' ? String(form.get('domainId') ?? '') : '',
        }),
      )}
    >
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {create.result.serverError ? (
        <FormMessage tone="error">{create.result.serverError}</FormMessage>
      ) : null}

      <Field
        id={`${id}-name`}
        label="Name"
        hint="What it is for, so you can tell keys apart: “Shop receipts”."
        error={fieldError(errors, 'name')}
      >
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={60}
          autoComplete="off"
          aria-invalid={fieldError(errors, 'name') ? true : undefined}
          aria-describedby={describedBy(`${id}-name`, fieldError(errors, 'name'), 'hint')}
          className={inputClass}
        />
      </Field>

      <fieldset>
        <legend className="text-sm font-medium">What it may do</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {allowed.map((option) => (
            <label
              key={option}
              className={cn(
                'flex cursor-pointer gap-3 rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-muted has-[:checked]:border-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              )}
            >
              <input
                type="radio"
                name="permission"
                value={option}
                checked={permission === option}
                onChange={() => setPermission(option)}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{PERMISSION_LABEL[option]}</span>
                <span className="mt-0.5 block text-xs/5 text-muted-foreground">
                  {PERMISSION_SUMMARY[option]}
                </span>
              </span>
            </label>
          ))}
        </div>
        {allowed.length === 1 ? (
          <p className="mt-2 text-xs/5 text-muted-foreground">
            Developers make sending keys. A full-access key is made by the account’s owner or an
            admin.
          </p>
        ) : null}
      </fieldset>

      {permission === 'sending' ? (
        <Field
          id={`${id}-domain`}
          label="Domain"
          hint="Limit the key to sending from one domain, or leave it for any of yours."
          error={fieldError(errors, 'domainId')}
        >
          <select
            id={`${id}-domain`}
            name="domainId"
            defaultValue=""
            aria-describedby={describedBy(`${id}-domain`, fieldError(errors, 'domainId'), 'hint')}
            className={inputClass}
          >
            <option value="">Any domain of this account</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
                {domain.status === 'verified' ? '' : ` (${domain.status})`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <SubmitButton pending={create.isPending} pendingLabel="Making the key…" className="sm:w-auto">
        Make the key
      </SubmitButton>
    </form>
  )
}

/** The key, once: copy it, say it is saved, and only then put it away. */
export function NewKeyPanel({ created, onDone }: { created: NewKey; onDone: () => void }) {
  const id = useId()
  const router = useRouter()
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const [saved, setSaved] = useState(false)

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4">
      <FormMessage tone="success">
        <p id={`${id}-title`} className="font-medium">
          Key “{created.name}” is ready — {PERMISSION_LABEL[created.permission].toLowerCase()}
        </p>
        <p>
          Copy it now and keep it somewhere safe, like your app’s secret settings. This is the only
          time it is shown: we keep a hash of it, never the key.
        </p>
      </FormMessage>
      <div>
        <label htmlFor={`${id}-key`} className="text-sm font-medium">
          Your API key
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-key`}
            readOnly
            value={created.key}
            onFocus={(event) => event.currentTarget.select()}
            className={cn(inputClass, 'font-mono text-sm')}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created.key)
                setCopied('yes')
              } catch {
                setCopied('failed')
              }
            }}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            {copied === 'yes' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === 'yes' ? 'Copied' : 'Copy key'}
          </button>
        </div>
        <p role="status" className="mt-1.5 min-h-5 text-xs text-muted-foreground">
          {copied === 'failed' ? 'Copying did not work here: select the key and copy it.' : ''}
        </p>
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.currentTarget.checked)}
          className="size-5 shrink-0 accent-primary"
        />
        I have saved it
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={() => {
          onDone()
          router.refresh()
        }}
        className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-6 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        Done
      </button>
    </section>
  )
}
