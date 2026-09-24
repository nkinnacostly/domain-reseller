'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { type NameserverMode, perZoneExplanation } from '../lib/nameservers'

const OPTION =
  'relative flex items-start gap-3 rounded-xl border border-border bg-background p-4 text-sm/6 transition-colors hover:bg-muted/60 has-[:checked]:border-ring has-[:checked]:bg-brand-subtle'
/** Above the label's cover, so the radio itself still takes a click. */
const RADIO =
  'relative z-10 mt-1 size-4 shrink-0 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
/** The label covers the whole card, so a tap anywhere on it picks the option (S7). */
const OPTION_LABEL = 'cursor-pointer font-medium text-foreground after:absolute after:inset-0'

/**
 * FR-C10 — collapsed by default, so checkout looks no longer for someone
 * without the values. Three ways in, as on the Nameservers tab (FR-D1):
 * leave the registrar's default, pick a host we hold verified nameservers
 * for (FR-D2), or enter them. The form reads the choice from its fields.
 */
export function NameserverChoice({
  presets,
  nameserverError,
  presetError,
  onChange,
}: {
  presets: NameserverPreset[]
  nameserverError?: string | undefined
  presetError?: string | undefined
  /** Any change of choice, so a problem found on submit can be cleared. */
  onChange?: () => void
}) {
  const id = useId()
  const details = useRef<HTMLDetailsElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<NameserverMode>('default')
  const [presetId, setPresetId] = useState('')
  const preset = presets.find((candidate) => candidate.id === presetId)

  // A problem inside a closed section would go unseen: open it, and take
  // the person to the field (the Pay button can be a screen away).
  useEffect(() => {
    if (!presetError && !nameserverError) return
    if (details.current) details.current.open = true
    const field = presetError ? select.current : box.current
    field?.focus()
  }, [presetError, nameserverError])

  const choose = (next: NameserverMode) => {
    setMode(next)
    onChange?.()
  }

  const option = (value: NameserverMode, label: string, hint: string) => (
    <div className={OPTION}>
      <input
        id={`${id}-mode-${value}`}
        type="radio"
        name="nameserverMode"
        value={value}
        checked={mode === value}
        onChange={() => choose(value)}
        aria-describedby={`${id}-mode-${value}-hint`}
        className={RADIO}
      />
      <div className="min-w-0">
        <label htmlFor={`${id}-mode-${value}`} className={OPTION_LABEL}>
          {label}
        </label>
        <p id={`${id}-mode-${value}-hint`} className="text-pretty text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  )

  return (
    <details ref={details} className="group rounded-2xl border border-border bg-background/80 p-5">
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        Already know where this domain is going?{' '}
        <span className="font-normal text-muted-foreground">Optional</span>
      </summary>

      <fieldset className="mt-4 space-y-3" aria-describedby={`${id}-about`}>
        <legend className="text-sm font-medium text-foreground">Nameservers</legend>
        <p id={`${id}-about`} className="text-pretty text-sm/6 text-muted-foreground">
          One choice for every domain in this order. You can change them later from the domain’s
          Nameservers tab.
        </p>

        {option(
          'default',
          'Leave the registrar’s default for now',
          'Point it at your host after registration, from the domain’s Nameservers tab.',
        )}

        {presets.length > 0
          ? option(
              'preset',
              'Pick my host',
              'Hosts whose nameservers we have checked against their own documentation.',
            )
          : null}
        {mode === 'preset' ? (
          <div className="space-y-3 pl-7">
            <Field id={`${id}-preset`} label="Your host" error={presetError}>
              <select
                ref={select}
                id={`${id}-preset`}
                name="presetId"
                value={presetId}
                onChange={(event) => {
                  setPresetId(event.target.value)
                  onChange?.()
                }}
                aria-invalid={presetError ? true : undefined}
                aria-describedby={describedBy(`${id}-preset`, presetError)}
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
        ) : null}

        {option('manual', 'Enter nameservers', 'Paste the two or more your host gave you.')}
        <div hidden={mode !== 'manual'} className="pl-7">
          <Field
            id={`${id}-nameservers`}
            label="Nameservers from your host"
            error={nameserverError}
            hint="One per line. We apply them straight after the domain is registered."
          >
            <textarea
              ref={box}
              id={`${id}-nameservers`}
              name="nameservers"
              rows={3}
              placeholder={'ns1.yourhost.com\nns2.yourhost.com'}
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={nameserverError ? true : undefined}
              aria-describedby={describedBy(`${id}-nameservers`, nameserverError, 'hint')}
              className={`${inputClass} h-auto py-2.5 font-mono text-sm`}
            />
          </Field>
        </div>
      </fieldset>
    </details>
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
