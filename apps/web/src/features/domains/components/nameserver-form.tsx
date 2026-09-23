'use client'

import { ShieldCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useRef, useState } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { requestNameservers } from '../actions/domains'
import type { NameserverPreset } from '../queries/domains'

/**
 * FR-D1 — one panel, three ways in: pick your host, paste what they sent, or
 * type it. Picking a preset fills the box; the box is the single source of
 * what gets saved.
 */
export function NameserverForm({
  domainId,
  domain,
  current,
  presets,
  hasTwoFactor,
  currentRecords,
}: {
  domainId: string
  domain: string
  current: string[] | null
  presets: NameserverPreset[]
  hasTwoFactor: boolean
  /** FR-N6 — what the current provider serves, so the customer sees what they would orphan. */
  currentRecords: string[]
}) {
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const [presetId, setPresetId] = useState<string>('')
  const save = useAction(requestNameservers)
  const preset = presets.find((candidate) => candidate.id === presetId)
  const data = save.result.data
  const serverError = save.result.serverError
  const needsStepUp = serverError?.startsWith("Confirm it's you")

  if (!hasTwoFactor) {
    return (
      <div className="rounded-2xl border border-border p-5">
        <p className="flex items-start gap-2.5 text-pretty text-sm/6 text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          Changing nameservers moves where your website and email live, so it needs two-factor
          authentication on your account.
        </p>
        <Link
          href="/app/settings#two-factor"
          className="mt-4 inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Turn on two-factor
        </Link>
      </div>
    )
  }

  return (
    <form
      aria-label="Change nameservers"
      noValidate
      className="space-y-5"
      onSubmit={onSubmitWith((form) =>
        save.execute({
          domainId,
          nameservers: String(form.get('nameservers') ?? ''),
          presetId: presetId || null,
        }),
      )}
    >
      <Field id={`${id}-host`} label="Where is your site hosted?">
        <select
          id={`${id}-host`}
          value={presetId}
          onChange={(event) => {
            setPresetId(event.target.value)
            const chosen = presets.find((candidate) => candidate.id === event.target.value)
            if (chosen && !chosen.assignsPerZone && box.current) {
              box.current.value = chosen.nameservers.join('\n')
            }
          }}
          className={inputClass}
        >
          <option value="">Somewhere else — I'll paste them</option>
          {presets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.provider}
            </option>
          ))}
        </select>
      </Field>

      {preset ? (
        <p className="-mt-2 text-pretty text-sm/6 text-muted-foreground">
          {preset.notes}{' '}
          <a
            href={preset.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {preset.provider}'s instructions
          </a>
        </p>
      ) : null}

      <Field
        id={`${id}-nameservers`}
        label="Nameservers"
        hint="Two or more, one per line — exactly as your host gave them."
      >
        <textarea
          ref={box}
          id={`${id}-nameservers`}
          name="nameservers"
          rows={4}
          defaultValue={(current ?? []).join('\n')}
          spellCheck={false}
          autoCapitalize="none"
          aria-describedby={describedBy(`${id}-nameservers`, undefined, 'hint')}
          className={`${inputClass} h-auto py-2.5 font-mono text-sm`}
        />
      </Field>

      {currentRecords.length > 0 ? (
        <div className="flex gap-2.5 rounded-xl bg-muted/60 p-4 text-pretty text-sm/6 text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            Your current DNS provider answers for {domain} right now: {currentRecords.join(', ')}.
            Once you switch, those records stop working unless your new host has them too — copy
            anything you still need, such as email (MX) records, first.
          </div>
        </div>
      ) : null}

      {data && 'error' in data ? (
        <FormMessage tone="error">
          <p>{data.error}</p>
          {data.details?.length ? (
            <ul className="mt-1 list-disc pl-5">
              {data.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </FormMessage>
      ) : null}
      {data && 'ok' in data ? (
        <FormMessage tone="success">
          {data.unchanged
            ? 'Those are already the nameservers on file — nothing to change.'
            : `Saved. We will apply them at the registry as soon as it is connected.`}
          {data.warnings.length ? (
            <ul className="mt-1 list-disc pl-5">
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </FormMessage>
      ) : null}
      {serverError ? (
        <FormMessage tone="error">
          {serverError}{' '}
          {needsStepUp ? (
            <Link
              href={`/verify?next=${encodeURIComponent(`/app/domains/${domain}/nameservers`)}`}
              className="font-medium underline underline-offset-2"
            >
              Enter a code
            </Link>
          ) : null}
        </FormMessage>
      ) : null}

      <SubmitButton
        pending={save.isPending}
        pendingLabel="Checking each nameserver…"
        className="sm:w-auto"
      >
        Save nameservers
      </SubmitButton>
    </form>
  )
}
