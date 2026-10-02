'use client'

import { Download, RefreshCw, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useEffect, useId, useRef, useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import {
  describedBy,
  Field,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { FOCUS, PANEL_HEADING } from '@/components/layout/panel'
import { BULK_RENEW_MAX, bulkRenewHref } from '@/features/renewals/lib/renewal'
import { cn } from '@/lib/utils'
import {
  type BulkResult,
  changeNameserversInBulk,
  labelDomainsInBulk,
  lockTransfersInBulk,
  setAutoRenewInBulk,
  setPrivacyInBulk,
  unlockTransfersInBulk,
} from '../actions/bulk'
import { csvFileName, portfolioCsv } from '../lib/csv'
import type { DomainLabel } from '../lib/labels'
import type { PortfolioDomain } from '../lib/portfolio'
import type { NameserverPreset } from '../queries/domains'
import { useBulkSelection } from './bulk-selection'
import { LabelChip } from './label-chip'
import { NeedsTwoFactor } from './settings-parts'

type Action = 'auto_renew' | 'nameservers' | 'transfer_lock' | 'privacy' | 'labels'

const ACTIONS: { id: Action; label: string }[] = [
  { id: 'auto_renew', label: 'Auto-renew' },
  { id: 'nameservers', label: 'Nameservers' },
  { id: 'transfer_lock', label: 'Transfer lock' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'labels', label: 'Labels' },
]

const count = (n: number) => `${n} ${n === 1 ? 'domain' : 'domains'}`

/** An on/off choice as a pair of radios — each a 44px target, named in words. */
function Choice({
  legend,
  name,
  options,
}: {
  legend: string
  name: string
  options: { value: string; label: string }[]
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-foreground">{legend}</legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {options.map((option, index) => (
          <label
            key={option.value}
            className={cn(
              'relative inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-background px-4 text-sm text-foreground transition hover:bg-muted',
              'has-checked:border-ring has-checked:ring-2 has-checked:ring-ring/40',
              'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={index === 0}
              className="size-4 accent-[var(--accent)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** A form's change to one radio group, by name — so the confirm button can follow the choice. */
function onRadio(name: string, handle: (value: string) => void) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.name === name) handle(target.value)
  }
}

/** Hands the file to the browser. Built here, from what the page shows (FR-P4). */
function download(fileName: string, text: string) {
  // A BOM, so Excel reads the file as UTF-8 (names in other scripts, FR-S8).
  const blob = new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * FR-P4 — act on many domains at once. Tick domains below (or all shown),
 * choose an action, set it, and confirm with the number of domains on the
 * button; anything that reaches the registry says so first. Each change
 * starts one bulk operation, and its page shows each domain's result.
 */
export function BulkBar({
  domains,
  labels,
  presets,
  hasTwoFactor,
  returnTo,
  renewAll,
}: {
  /** The domains shown, in order. */
  domains: PortfolioDomain[]
  labels: DomainLabel[]
  presets: NameserverPreset[]
  hasTwoFactor: boolean
  /** Where a second-factor prompt comes back to: this list, filtered as it is. */
  returnTo: string
  /** FR-P5 — the expiry view offers to renew everything it shows. */
  renewAll: boolean
}) {
  const id = useId()
  const { shown, selected, setAll } = useBulkSelection()
  const [open, setOpen] = useState<Action | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const chosen = domains.filter((domain) => selected.has(domain.id))
  const some = selected.size > 0 && selected.size < shown.length

  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = some
  }, [some])
  // A panel that opens takes focus, so a keyboard or screen-reader user lands on it.
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])
  // Nothing ticked, nothing to act on: an open panel closes.
  useEffect(() => {
    if (selected.size === 0) setOpen(null)
  }, [selected.size])

  const exportCsv = () => {
    const rows = chosen.length > 0 ? chosen : domains
    download(
      csvFileName(new Date()),
      portfolioCsv(rows, (status) => STATUS_LABEL[status]),
    )
  }

  const renewIds = chosen.map((domain) => domain.id)
  const allIds = domains.map((domain) => domain.id)

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="mt-4 rounded-2xl border border-border bg-background/80 p-3 sm:p-4"
    >
      <h3 id={`${id}-heading`} className="sr-only">
        Act on several domains
      </h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label
          className={cn(
            'relative inline-flex min-h-11 cursor-pointer items-center gap-2.5 rounded-full pr-3 pl-3.5 text-sm font-medium text-foreground hover:bg-muted',
            'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
          )}
        >
          <input
            ref={selectAll}
            type="checkbox"
            checked={selected.size > 0 && selected.size === shown.length}
            onChange={(event) => setAll(event.target.checked)}
            // Says how many "all" is; it keeps the visible words first (WCAG 2.5.3).
            aria-label={`Select all ${count(shown.length)} shown`}
            className="size-4 cursor-pointer accent-[var(--accent)]"
          />
          Select all
        </label>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {selected.size === 0 ? 'None selected' : `${selected.size} selected`}
        </p>
        {selected.size > 0 ? (
          <button
            type="button"
            onClick={() => setAll(false)}
            className={cn(
              'min-h-11 rounded-full px-3 text-sm text-foreground underline underline-offset-2 hover:bg-muted',
              FOCUS,
            )}
          >
            Clear
          </button>
        ) : null}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {renewAll && selected.size === 0 && allIds.length <= BULK_RENEW_MAX ? (
            <Link href={bulkRenewHref(allIds)} className={QUIET_BUTTON}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Renew all {count(allIds.length)}
            </Link>
          ) : null}
          <button type="button" onClick={exportCsv} className={QUIET_BUTTON}>
            <Download className="size-4" aria-hidden="true" />
            {chosen.length > 0 ? `Export ${chosen.length} as CSV` : 'Export all as CSV'}
          </button>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 border-border border-t pt-3">
          {renewIds.length <= BULK_RENEW_MAX ? (
            <Link href={bulkRenewHref(renewIds)} className={QUIET_BUTTON}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Renew
            </Link>
          ) : (
            <p className="flex min-h-11 items-center text-sm text-muted-foreground">
              Renew up to {BULK_RENEW_MAX} at a time.
            </p>
          )}
          {ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              aria-expanded={open === action.id}
              aria-controls={open === action.id ? `${id}-panel` : undefined}
              onClick={() => setOpen((current) => (current === action.id ? null : action.id))}
              className={cn(
                QUIET_BUTTON,
                'aria-expanded:border-brand aria-expanded:bg-brand aria-expanded:text-brand-foreground aria-expanded:hover:bg-brand/90',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      {open && selected.size > 0 ? (
        <div
          id={`${id}-panel`}
          className="mt-3 rounded-2xl border border-border bg-card p-4 sm:p-5"
        >
          <h4 ref={heading} tabIndex={-1} className={cn(PANEL_HEADING, 'rounded outline-none')}>
            {ACTIONS.find((action) => action.id === open)?.label} for {count(selected.size)}
          </h4>
          <div className="mt-3">
            <ActionPanel
              key={open}
              action={open}
              domainIds={[...selected]}
              labels={labels}
              presets={presets}
              hasTwoFactor={hasTwoFactor}
              returnTo={returnTo}
              onCancel={() => setOpen(null)}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}

type PanelProps = {
  action: Action
  domainIds: string[]
  labels: DomainLabel[]
  presets: NameserverPreset[]
  hasTwoFactor: boolean
  returnTo: string
  onCancel: () => void
}

/** Where a started change goes: its results page, unless there are warnings to read first. */
function useStarted() {
  const router = useRouter()
  const [started, setStarted] = useState<{ operationId: string; warnings: string[] } | null>(null)
  return {
    started,
    onSuccess: ({ data }: { data?: BulkResult | undefined }) => {
      if (!data || !('ok' in data)) return
      if (data.warnings.length > 0) setStarted(data)
      else router.push(`/app/domains/bulk/${data.operationId}`)
    },
  }
}

function problemOf(result: {
  data?: BulkResult | undefined
  serverError?: string | undefined
  validationErrors?: unknown
}): { message: string; details?: string[] } | null {
  if (result.serverError) return { message: result.serverError }
  if (result.data && 'error' in result.data) {
    return { message: result.data.error, details: result.data.details }
  }
  if (result.validationErrors) return { message: 'That did not go through. Please try again.' }
  return null
}

function Problem({
  problem,
  returnTo,
}: {
  problem: { message: string; details?: string[] } | null
  returnTo: string
}) {
  if (!problem) return null
  if (!problem.details?.length) return <ActionError message={problem.message} returnTo={returnTo} />
  return (
    <FormMessage tone="error">
      <p>{problem.message}</p>
      <ul className="mt-1 list-disc pl-5">
        {problem.details.map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>
    </FormMessage>
  )
}

function Buttons({
  pending,
  label,
  pendingLabel = 'Starting…',
  onCancel,
}: {
  pending: boolean
  label: string
  pendingLabel?: string
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <SubmitButton pending={pending} pendingLabel={pendingLabel} className="sm:w-auto">
        {label}
      </SubmitButton>
      <button type="button" onClick={onCancel} disabled={pending} className={QUIET_BUTTON}>
        Cancel
      </button>
    </div>
  )
}

const REGISTRY_NOTE =
  'This sends a change to the registry for each domain. The next page shows each one’s result as it is applied; any that cannot take it are skipped, and say why.'

function ActionPanel(props: PanelProps) {
  switch (props.action) {
    case 'auto_renew':
      return <AutoRenewPanel {...props} />
    case 'transfer_lock':
      return <TransferLockPanel {...props} />
    case 'privacy':
      return <PrivacyPanel {...props} />
    case 'labels':
      return <LabelsPanel {...props} />
    case 'nameservers':
      return <NameserversPanel {...props} />
  }
}

function AutoRenewPanel({ domainIds, returnTo, onCancel }: PanelProps) {
  const { onSuccess } = useStarted()
  const save = useAction(setAutoRenewInBulk, { onSuccess })
  const [enabled, setEnabled] = useState(true)
  return (
    <form
      aria-label="Auto-renew for the selected domains"
      className="space-y-4"
      onChange={onRadio('enabled', (value) => setEnabled(value === 'on'))}
      onSubmit={onSubmitWith((form) =>
        save.execute({ domainIds, enabled: form.get('enabled') === 'on' }),
      )}
    >
      <Choice
        legend="Renew automatically"
        name="enabled"
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
      {/* N9b — the same words as the one-domain switch: this is a preference for now. */}
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Automatic renewal isn’t switched on yet — this records what you want. Until it is, renew
        from the Renew button above.
      </p>
      <Problem problem={problemOf(save.result)} returnTo={returnTo} />
      <Buttons
        pending={save.isPending}
        label={`Turn auto-renew ${enabled ? 'on' : 'off'} for ${count(domainIds.length)}`}
        onCancel={onCancel}
      />
    </form>
  )
}

function TransferLockPanel({ domainIds, hasTwoFactor, returnTo, onCancel }: PanelProps) {
  const { onSuccess } = useStarted()
  const lock = useAction(lockTransfersInBulk, { onSuccess })
  const unlock = useAction(unlockTransfersInBulk, { onSuccess })
  const [locked, setLocked] = useState(true)
  const pending = lock.isPending || unlock.isPending
  const result = locked ? lock.result : unlock.result
  return (
    <form
      aria-label="Transfer lock for the selected domains"
      className="space-y-4"
      onChange={onRadio('locked', (value) => setLocked(value === 'on'))}
      onSubmit={onSubmitWith((form) =>
        form.get('locked') === 'on' ? lock.execute({ domainIds }) : unlock.execute({ domainIds }),
      )}
    >
      <Choice
        legend="Transfer lock"
        name="locked"
        options={[
          { value: 'on', label: 'Locked' },
          { value: 'off', label: 'Unlocked' },
        ]}
      />
      {!locked && !hasTwoFactor ? (
        <NeedsTwoFactor>
          Turning the transfer lock off lets a domain be moved to another registrar, so it needs
          two-factor authentication on your account.
        </NeedsTwoFactor>
      ) : (
        <>
          <p className="text-pretty text-sm/6 text-muted-foreground">
            {locked
              ? 'A locked domain cannot be transferred away. '
              : 'Unlocked, a domain can be transferred to another registrar with its transfer code. You’ll be asked for a code from your authenticator app. '}
            {REGISTRY_NOTE}
          </p>
          <Problem problem={problemOf(result)} returnTo={returnTo} />
          <Buttons
            pending={pending}
            label={`${locked ? 'Lock' : 'Unlock'} ${count(domainIds.length)}`}
            onCancel={onCancel}
          />
        </>
      )}
    </form>
  )
}

function PrivacyPanel({ domainIds, returnTo, onCancel }: PanelProps) {
  const { onSuccess } = useStarted()
  const save = useAction(setPrivacyInBulk, { onSuccess })
  const [enabled, setEnabled] = useState(true)
  return (
    <form
      aria-label="Contact privacy for the selected domains"
      className="space-y-4"
      onChange={onRadio('enabled', (value) => setEnabled(value === 'on'))}
      onSubmit={onSubmitWith((form) =>
        save.execute({ domainIds, enabled: form.get('enabled') === 'on' }),
      )}
    >
      <Choice
        legend="Contact privacy"
        name="enabled"
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Privacy is offered on generic extensions such as .com; country extensions such as .ng are
        skipped. {REGISTRY_NOTE}
      </p>
      <Problem problem={problemOf(save.result)} returnTo={returnTo} />
      <Buttons
        pending={save.isPending}
        label={`Turn privacy ${enabled ? 'on' : 'off'} for ${count(domainIds.length)}`}
        onCancel={onCancel}
      />
    </form>
  )
}

function LabelsPanel({ domainIds, labels, returnTo, onCancel }: PanelProps) {
  const id = useId()
  const { onSuccess } = useStarted()
  const save = useAction(labelDomainsInBulk, { onSuccess })
  const [labelId, setLabelId] = useState(labels[0]?.id ?? '')
  const [on, setOn] = useState(true)
  const label = labels.find((candidate) => candidate.id === labelId)

  if (labels.length === 0) {
    return (
      <div className="space-y-3 text-sm/6">
        <p className="text-pretty text-foreground">You have no labels yet.</p>
        <Link href="/app/settings/labels" className={QUIET_BUTTON}>
          Create a label
        </Link>
      </div>
    )
  }
  return (
    <form
      aria-label="Labels for the selected domains"
      className="space-y-4"
      onChange={onRadio('on', (value) => setOn(value === 'add'))}
      onSubmit={onSubmitWith((form) =>
        save.execute({ domainIds, labelId, on: form.get('on') === 'add' }),
      )}
    >
      <Choice
        legend="Add or remove"
        name="on"
        options={[
          { value: 'add', label: 'Add a label' },
          { value: 'remove', label: 'Remove a label' },
        ]}
      />
      <Field id={`${id}-label`} label="Label">
        <select
          id={`${id}-label`}
          value={labelId}
          onChange={(event) => setLabelId(event.target.value)}
          className={inputClass}
        >
          {labels.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </Field>
      {label ? (
        <p className="text-sm text-muted-foreground">
          Shows as <LabelChip label={label} />
        </p>
      ) : null}
      <Problem problem={problemOf(save.result)} returnTo={returnTo} />
      <Buttons
        pending={save.isPending}
        label={
          label
            ? `${on ? 'Add' : 'Remove'} “${label.name}” ${on ? 'to' : 'from'} ${count(domainIds.length)}`
            : 'Choose a label'
        }
        onCancel={onCancel}
      />
    </form>
  )
}

/**
 * FR-N2 — one set for every selected domain, from a verified preset (N11:
 * only the ones customers can see) or typed. Checked against live DNS once
 * before anything is saved (FR-D4).
 */
function NameserversPanel({ domainIds, presets, hasTwoFactor, returnTo, onCancel }: PanelProps) {
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const [presetId, setPresetId] = useState('')
  const { started, onSuccess } = useStarted()
  const save = useAction(changeNameserversInBulk, { onSuccess })
  const preset = presets.find((candidate) => candidate.id === presetId)

  if (!hasTwoFactor) {
    return (
      <NeedsTwoFactor>
        Changing nameservers moves where your websites and email live, so it needs two-factor
        authentication on your account.
      </NeedsTwoFactor>
    )
  }
  if (started) {
    return (
      <FormMessage tone="success">
        <p>Started. Some nameservers need a second look:</p>
        <ul className="mt-1 list-disc pl-5">
          {started.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        <Link
          href={`/app/domains/bulk/${started.operationId}`}
          className="mt-2 inline-block font-medium underline underline-offset-2"
        >
          See each domain’s result
        </Link>
      </FormMessage>
    )
  }
  return (
    <form
      aria-label="Nameservers for the selected domains"
      noValidate
      className="space-y-4"
      onSubmit={onSubmitWith((form) =>
        save.execute({
          domainIds,
          nameservers: String(form.get('nameservers') ?? ''),
          presetId: presetId || null,
        }),
      )}
    >
      <Field id={`${id}-host`} label="Where are these sites hosted?">
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
          <option value="">Somewhere else — I’ll paste them</option>
          {presets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.provider}
            </option>
          ))}
        </select>
      </Field>
      {preset?.assignsPerZone ? (
        <p className="-mt-1 text-pretty text-sm/6 text-muted-foreground">
          {preset.provider} gives each domain its own nameservers, so one set does not fit them all.
          Set them from each domain’s Nameservers tab instead.
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
          spellCheck={false}
          autoCapitalize="none"
          aria-describedby={describedBy(`${id}-nameservers`, undefined, 'hint')}
          className={`${inputClass} h-auto py-2.5 font-mono text-sm`}
        />
      </Field>
      {/* FR-N6 — what switching hosts does to what is served now. */}
      <div className="flex gap-2.5 rounded-xl bg-muted/60 p-4 text-pretty text-sm/6 text-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <p>
          Records each domain’s current DNS provider serves — its website, its email (MX) — stop
          working unless the new host has them too. Check a domain’s Nameservers tab to see what it
          serves now. {REGISTRY_NOTE}
        </p>
      </div>
      <Problem problem={problemOf(save.result)} returnTo={returnTo} />
      <Buttons
        pending={save.isPending}
        label={`Point ${count(domainIds.length)} at these nameservers`}
        pendingLabel="Checking each nameserver…"
        onCancel={onCancel}
      />
    </form>
  )
}
