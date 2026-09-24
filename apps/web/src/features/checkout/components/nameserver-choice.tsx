'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import type { HostProblem } from '../lib/line-hosts'
import type { NameserverMode } from '../lib/nameservers'
import { PresetPicker, TypedNameservers } from './host-fields'
import { LineHosts } from './line-hosts'

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
 * for (FR-D2), or enter them. The choice covers the whole order; a mixed
 * cart can give a domain its own. The form reads every choice from its fields.
 */
export function NameserverChoice({
  presets,
  domains = [],
  problem,
  onChange,
}: {
  presets: NameserverPreset[]
  /** The order's domains — two or more can each be given their own host. */
  domains?: readonly string[]
  /** A choice that cannot work, shown beside the field it belongs to. */
  problem?: HostProblem | undefined
  /** Any change of choice, so a problem found on submit can be cleared. */
  onChange?: () => void
}) {
  const id = useId()
  const details = useRef<HTMLDetailsElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<NameserverMode>('default')
  const [presetId, setPresetId] = useState('')
  const presetError = problem?.field === 'presetId' ? problem.error : undefined
  const nameserverError = problem?.field === 'nameservers' ? problem.error : undefined
  const mixed = domains.length > 1
  // By value: the form rebuilds the problem on every render, and focus must
  // move only when a new one arrives.
  const problemKey = problem ? `${problem.field} ${problem.domain ?? ''} ${problem.error}` : ''

  // A problem inside a closed section would go unseen: open it, and take
  // the person to the field (the Pay button can be a screen away). A
  // domain's own choice takes them to its field itself.
  useEffect(() => {
    if (!problemKey) return
    if (details.current) details.current.open = true
    if (presetError) select.current?.focus()
    else if (nameserverError) box.current?.focus()
  }, [problemKey, presetError, nameserverError])

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
          {mixed
            ? 'One choice for every domain in this order, unless you give a domain its own below.'
            : 'One choice for every domain in this order.'}{' '}
          You can change them later from the domain’s Nameservers tab.
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
          <div className="pl-7">
            <PresetPicker
              ref={select}
              id={`${id}-preset`}
              name="presetId"
              label="Your host"
              presets={presets}
              value={presetId}
              onChange={(next) => {
                setPresetId(next)
                onChange?.()
              }}
              error={presetError}
            />
          </div>
        ) : null}

        {option('manual', 'Enter nameservers', 'Paste the two or more your host gave you.')}
        <div hidden={mode !== 'manual'} className="pl-7">
          <TypedNameservers
            ref={box}
            id={`${id}-nameservers`}
            name="nameservers"
            label="Nameservers from your host"
            error={nameserverError}
            onChange={onChange}
          />
        </div>
      </fieldset>

      {mixed ? (
        <LineHosts
          domains={domains}
          presets={presets}
          problem={problem?.field === 'lineHosts' ? problem : undefined}
          onChange={onChange}
        />
      ) : null}
    </details>
  )
}
