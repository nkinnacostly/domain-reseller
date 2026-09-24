'use client'

import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { DomainName, domainLabel } from '@/components/common/domain-name'
import { describedBy, Field, FormMessage, inputClass } from '@/components/common/form-parts'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { type HostProblem, type LineMode, lineField } from '../lib/line-hosts'
import { PresetPicker, TypedNameservers } from './host-fields'

/**
 * FR-C10 — a per-domain override for mixed carts. It sits folded inside the
 * nameserver section, which is itself folded, so checkout looks no longer
 * for anyone who does not need it. Every domain follows the order's choice
 * until it is given its own, from the same three ways in (FR-D1).
 */
export function LineHosts({
  domains,
  presets,
  problem,
  onChange,
}: {
  domains: readonly string[]
  presets: NameserverPreset[]
  /** A problem with one domain's choice — or, without a domain, with them all. */
  problem?: HostProblem | undefined
  onChange?: (() => void) | undefined
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const problemKey = problem ? `${problem.domain ?? ''} ${problem.error}` : ''

  // A problem inside a closed section would go unseen.
  useEffect(() => {
    if (problemKey && details.current) details.current.open = true
  }, [problemKey])

  return (
    <details ref={details} className="group/line mt-4 border-border border-t pt-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-medium text-foreground marker:hidden hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:opacity-80">
        Use a different host for a domain
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/line:rotate-180"
        />
      </summary>
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Each domain uses the choice above unless you change it here.
      </p>
      {problem && !problem.domain ? (
        <FormMessage tone="error" className="mt-3">
          {problem.error}
        </FormMessage>
      ) : null}
      <ul aria-label="Host for each domain" className="mt-3 space-y-3">
        {domains.map((domain) => (
          <li key={domain}>
            <LineHost
              domain={domain}
              presets={presets}
              error={problem?.domain === domain ? problem.error : undefined}
              onChange={onChange}
            />
          </li>
        ))}
      </ul>
    </details>
  )
}

function LineHost({
  domain,
  presets,
  error,
  onChange,
}: {
  domain: string
  presets: NameserverPreset[]
  error?: string | undefined
  onChange?: (() => void) | undefined
}) {
  const id = useId()
  const card = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<LineMode>('same')
  const [presetId, setPresetId] = useState('')
  const modeError = mode === 'same' || mode === 'default' ? error : undefined
  /** Said by screen readers, where the card's heading is not. */
  const forDomain = <span className="sr-only"> for {domainLabel(domain)}</span>

  // Take the person to the field with the problem: the Pay button can be a screen away.
  useEffect(() => {
    if (error) card.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [error])

  return (
    <div ref={card} className="space-y-3 rounded-xl border border-border bg-background p-3 sm:p-4">
      <Field
        id={`${id}-mode`}
        label={
          <span className="break-all">
            <DomainName name={domain} />
          </span>
        }
        error={modeError}
      >
        <select
          id={`${id}-mode`}
          name={lineField(domain, 'mode')}
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as LineMode)
            onChange?.()
          }}
          aria-invalid={modeError ? true : undefined}
          aria-describedby={describedBy(`${id}-mode`, modeError)}
          className={inputClass}
        >
          <option value="same">Same as the rest</option>
          <option value="default">Leave the registrar’s default for now</option>
          {presets.length > 0 ? <option value="preset">Pick my host</option> : null}
          <option value="manual">Enter nameservers</option>
        </select>
      </Field>

      {mode === 'preset' ? (
        <PresetPicker
          id={`${id}-preset`}
          name={lineField(domain, 'presetId')}
          label={<>Host{forDomain}</>}
          presets={presets}
          value={presetId}
          onChange={(next) => {
            setPresetId(next)
            onChange?.()
          }}
          error={error}
        />
      ) : null}
      <div hidden={mode !== 'manual'}>
        <TypedNameservers
          id={`${id}-nameservers`}
          name={lineField(domain, 'nameservers')}
          label={<>Nameservers{forDomain}</>}
          error={mode === 'manual' ? error : undefined}
          onChange={onChange}
        />
      </div>
    </div>
  )
}
