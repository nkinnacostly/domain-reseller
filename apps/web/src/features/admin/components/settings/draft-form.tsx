'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { Textarea } from '@/components/ui/textarea'
import { savePresetDraft } from '@/features/admin/actions/presets'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { PRESET_COPY, saveDraftCopy } from '@/features/admin/lib/settings-copy'
import { PRESETS_BASE } from '@/features/admin/lib/settings-params'
import { parseNameservers, sourceUrlProblem } from '@/features/admin/lib/settings-presets'

/**
 * Save a change to a preset — or a new host — as a draft (docs/ADMIN-SPEC.md
 * §5.2 B13, D21). Customers keep the live nameservers until the draft passes
 * a public-DNS check and the owner publishes it. The form checks what SQL
 * will: hostnames, 2 to 13 of them (none for a host that assigns them per
 * domain), an https source. Whether the source's site is the provider's own
 * is SQL's to say: the allowed sites live in the database.
 */

export type DraftStart = {
  /** The preset this changes; null for a new host. */
  presetId: string | null
  provider: string
  nameservers: string[]
  sourceUrl: string
  notes: string | null
  assignsPerZone: boolean
}

const PROVIDER_MAX = 60
const NOTES_MAX = 500

export function DraftForm({ start, returnTo }: { start: DraftStart; returnTo: string }) {
  const router = useRouter()
  const id = useId()
  const isNew = start.presetId === null
  const [provider, setProvider] = useState(start.provider)
  const [hostsText, setHostsText] = useState(start.nameservers.join('\n'))
  const [sourceUrl, setSourceUrl] = useState(start.sourceUrl)
  const [notes, setNotes] = useState(start.notes ?? '')
  const [perZone, setPerZone] = useState(start.assignsPerZone)
  const [touched, setTouched] = useState(false)

  const name = provider.trim()
  const providerError =
    isNew && touched && (name.length < 2 || name.length > PROVIDER_MAX)
      ? 'Name the provider in 2 to 60 characters.'
      : undefined
  const hosts = parseNameservers(hostsText, perZone)
  const hostsError = touched && !hosts.ok ? hosts.error : undefined
  const sourceError = touched ? (sourceUrlProblem(sourceUrl) ?? undefined) : undefined
  const notesError =
    notes.trim().length > NOTES_MAX ? 'Keep the notes under 500 characters.' : undefined
  const parsed = hosts.ok ? hosts.hosts : []
  const unchanged =
    !isNew &&
    perZone === start.assignsPerZone &&
    sourceUrl.trim() === start.sourceUrl &&
    notes.trim() === (start.notes ?? '') &&
    parsed.join(' ') === start.nameservers.join(' ')
  const ready =
    (!isNew || (name.length >= 2 && name.length <= PROVIDER_MAX)) &&
    hosts.ok &&
    sourceUrlProblem(sourceUrl) === null &&
    !notesError &&
    !unchanged
  const copy = saveDraftCopy(isNew ? name || 'the new host' : start.provider)
  const hostsHint = perZone
    ? 'Leave this empty: the host gives each domain its own.'
    : 'One per line, 2 to 13, from the provider’s own documentation.'

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className="space-y-4"
      onSubmit={(event) => event.preventDefault()}
      onBlur={() => setTouched(true)}
      noValidate
    >
      <h3 id={`${id}-heading`} className="text-sm font-semibold text-foreground">
        {isNew ? 'A new host' : 'Save a change as a draft'}
      </h3>
      {isNew ? (
        <Field id={`${id}-provider`} label="Provider" error={providerError}>
          <input
            id={`${id}-provider`}
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            maxLength={PROVIDER_MAX + 10}
            autoComplete="off"
            aria-invalid={providerError ? true : undefined}
            aria-describedby={describedBy(`${id}-provider`, providerError)}
            className={inputClass}
          />
        </Field>
      ) : null}
      <label className="flex min-h-11 items-start gap-3 text-sm text-foreground">
        <input
          type="checkbox"
          checked={perZone}
          onChange={(event) => setPerZone(event.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-brand"
        />
        <span>The host gives each domain its own nameservers (Cloudflare and Netlify do).</span>
      </label>
      <Field id={`${id}-hosts`} label="Nameservers" error={hostsError} hint={hostsHint}>
        <Textarea
          id={`${id}-hosts`}
          value={hostsText}
          onChange={(event) => setHostsText(event.target.value)}
          rows={4}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={hostsError ? true : undefined}
          aria-describedby={describedBy(`${id}-hosts`, hostsError, hostsHint)}
          className="font-mono"
        />
      </Field>
      <Field
        id={`${id}-source`}
        label="Source: the provider's own page"
        error={sourceError}
        hint={PRESET_COPY.sourceRule}
      >
        <input
          id={`${id}-source`}
          type="url"
          inputMode="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={sourceError ? true : undefined}
          aria-describedby={describedBy(`${id}-source`, sourceError, PRESET_COPY.sourceRule)}
          className={inputClass}
        />
      </Field>
      <Field id={`${id}-notes`} label="Notes (optional)" error={notesError}>
        <Textarea
          id={`${id}-notes`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={2}
          aria-invalid={notesError ? true : undefined}
          aria-describedby={describedBy(`${id}-notes`, notesError)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmAction
          trigger={PRESET_COPY.saveConfirm}
          disabled={!ready}
          title={copy.title}
          rows={[
            {
              label: 'Now',
              value: isNew
                ? 'Not offered yet'
                : start.assignsPerZone
                  ? 'Per domain'
                  : start.nameservers.join(', '),
            },
            { label: 'Draft', value: perZone ? 'Per domain' : parsed.join(', ') },
          ]}
          body={copy.body}
          confirmLabel={PRESET_COPY.saveConfirm}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={PRESET_COPY.saveDone}
          run={async ({ reason, requestKey, code }) => {
            const result = adminOutcome(
              await savePresetDraft({
                presetId: start.presetId,
                ...(isNew ? { provider: name } : {}),
                nameservers: perZone ? [] : parsed,
                sourceUrl: sourceUrl.trim(),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
                assignsPerZone: perZone,
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
            // A new host's draft has its own page until it is published.
            const draftId = result.ok ? result.after?.draft_id : undefined
            if (isNew && typeof draftId === 'string') router.push(`${PRESETS_BASE}/${draftId}`)
            return result
          }}
        />
        {unchanged ? (
          <p className="text-sm text-muted-foreground">Change something to save a draft.</p>
        ) : null}
      </div>
    </form>
  )
}
