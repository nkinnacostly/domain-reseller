'use client'

import type { ReactNode, Ref } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { perZoneExplanation } from '../lib/nameservers'

/**
 * The two inputs behind FR-C10's choices, shared by the order's choice and a
 * domain's own (FR-D1): a host from our verified presets (FR-D2), or the
 * nameservers a host gave. The form reads both by name.
 */

export function PresetPicker({
  id,
  name,
  label,
  presets,
  value,
  onChange,
  error,
  ref,
}: {
  id: string
  name: string
  label: ReactNode
  presets: NameserverPreset[]
  value: string
  onChange: (presetId: string) => void
  error?: string | undefined
  ref?: Ref<HTMLSelectElement>
}) {
  const preset = presets.find((candidate) => candidate.id === value)
  return (
    <div className="space-y-3">
      <Field id={id} label={label} error={error}>
        <select
          ref={ref}
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error)}
          className={inputClass}
        >
          <option value="">Choose your host</option>
          {presets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.provider}
            </option>
          ))}
        </select>
      </Field>
      {preset ? <PresetDetail preset={preset} /> : null}
    </div>
  )
}

export function TypedNameservers({
  id,
  name,
  label,
  error,
  onChange,
  ref,
}: {
  id: string
  name: string
  label: ReactNode
  error?: string | undefined
  onChange?: () => void
  ref?: Ref<HTMLTextAreaElement>
}) {
  return (
    <Field
      id={id}
      label={label}
      error={error}
      hint="One per line. We apply them straight after the domain is registered."
    >
      <textarea
        ref={ref}
        id={id}
        name={name}
        rows={3}
        placeholder={'ns1.yourhost.com\nns2.yourhost.com'}
        spellCheck={false}
        autoCapitalize="none"
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, 'hint')}
        className={`${inputClass} h-auto py-2.5 font-mono text-sm`}
      />
    </Field>
  )
}

/** What a chosen preset sets — or, for a per-zone provider (FR-D3), why it cannot yet. */
function PresetDetail({ preset }: { preset: NameserverPreset }) {
  const instructions = (
    <a
      href={preset.sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {preset.provider}’s instructions
    </a>
  )
  return (
    <div className="rounded-xl bg-muted/60 px-4 py-3 text-pretty text-sm/6">
      {preset.assignsPerZone ? (
        <p className="text-foreground">{perZoneExplanation(preset.provider)}</p>
      ) : (
        <>
          <p className="text-foreground">Applied straight after the domain is registered:</p>
          <ul aria-label={`${preset.provider} nameservers`} className="mt-1 font-mono text-xs">
            {preset.nameservers.map((host) => (
              <li key={host} className="break-all text-foreground">
                {host}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-muted-foreground">
        {preset.notes ? `${preset.notes} ` : ''}
        {instructions}
      </p>
    </div>
  )
}
