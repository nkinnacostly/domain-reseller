'use client'

import { NAMESERVERS_MAX, NAMESERVERS_MIN } from '@dr/shared/schemas'
import { Check, Globe, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Field, FormMessage, inputClass, SubmitButton } from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import { type NameserverDelivery, requestNameservers } from '../actions/domains'
import {
  joinRows,
  type NameserverRow,
  pastedNameservers,
  pasteInto,
  toRows,
} from '../lib/nameserver-rows'
import type { NameserverPreset } from '../queries/domains'

const DELIVERY_MESSAGE: Record<NameserverDelivery, string> = {
  queued: 'Saved and sent to the registry. Activity shows when it is applied.',
  after_registration: 'Saved. They are applied as soon as the registration completes.',
  demo: 'Saved. This is a demo domain, so nothing is sent to a registry.',
}

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * FR-D1 — one panel, three ways in: pick your host, paste what they sent, or
 * type it. One row per nameserver; picking a preset or "Use default DNS"
 * fills the rows, and the rows are the single source of what gets saved.
 * Saving is unchanged: the rows go to `requestNameservers` one per line, with
 * its second-factor step-up and live DNS check (SEC-2, FR-D4).
 */
export function NameserverForm({
  domainId,
  domain,
  current,
  currentPresetId = null,
  presets,
  registrarDefault = null,
  hasTwoFactor,
  currentRecords,
}: {
  domainId: string
  domain: string
  current: string[] | null
  /** The host picked for the current set — at checkout or here — so the choice shows as made. */
  currentPresetId?: string | null
  presets: NameserverPreset[]
  /** The registrar's default for this domain's side (migration 35); none, no "Use default DNS". */
  registrarDefault?: NameserverPreset | null
  hasTwoFactor: boolean
  /** FR-N6 — what the current provider serves, so the customer sees what they would orphan. */
  currentRecords: string[]
}) {
  const id = useId()
  const keys = useRef(0)
  const nextKey = () => {
    keys.current += 1
    return keys.current
  }
  const [rows, setRows] = useState<NameserverRow[]>(() => toRows(current ?? [], nextKey))
  const inputs = useRef(new Map<number, HTMLInputElement>())
  const addButton = useRef<HTMLButtonElement>(null)
  const offered = (candidate: string | null) =>
    presets.some((preset) => preset.id === candidate) || registrarDefault?.id === candidate
  const [presetId, setPresetId] = useState<string>(
    offered(currentPresetId) ? (currentPresetId ?? '') : '',
  )
  const save = useAction(requestNameservers)
  const preset = presets.find((candidate) => candidate.id === presetId)
  const onDefault = registrarDefault !== null && presetId === registrarDefault.id
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

  const focusRow = (row: NameserverRow | undefined) => {
    if (row) inputs.current.get(row.key)?.focus()
    else addButton.current?.focus()
  }

  // flushSync so the new or following row exists before focus moves to it.
  const addRow = () => {
    const row = { key: nextKey(), value: '' }
    flushSync(() => setRows((before) => [...before, row]))
    focusRow(row)
  }

  const removeRow = (index: number) => {
    if (rows.length <= NAMESERVERS_MIN) return
    const next = rows.filter((_, n) => n !== index)
    flushSync(() => setRows(next))
    // The row that moved up into its place, or Add row after the last.
    focusRow(next[index])
  }

  const typeInto = (index: number, value: string) =>
    setRows((before) => before.map((row, n) => (n === index ? { ...row, value } : row)))

  const pasteList = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    const hosts = pastedNameservers(event.clipboardData.getData('text'))
    if (!hosts) return
    event.preventDefault()
    const next = pasteInto(rows, index, hosts, nextKey)
    flushSync(() => setRows(next))
    focusRow(next[index + hosts.length - 1])
  }

  const fillDefault = () => {
    if (!registrarDefault) return
    setPresetId(registrarDefault.id)
    setRows(toRows(registrarDefault.nameservers, nextKey))
  }

  return (
    <form
      aria-label="Change nameservers"
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        save.execute({ domainId, nameservers: joinRows(rows), presetId: presetId || null })
      }}
    >
      <Field id={`${id}-host`} label="Where is your site hosted?">
        <select
          id={`${id}-host`}
          value={presetId}
          onChange={(event) => {
            setPresetId(event.target.value)
            const chosen = presets.find((candidate) => candidate.id === event.target.value)
            if (chosen && !chosen.assignsPerZone) setRows(toRows(chosen.nameservers, nextKey))
          }}
          className={inputClass}
        >
          <option value="">Somewhere else — I'll paste them</option>
          {/* Shown only while chosen, by "Use default DNS": the registrar's own pair is not a host. */}
          {onDefault ? (
            <option value={registrarDefault.id} disabled>
              Nowhere yet — the registrar's default
            </option>
          ) : null}
          {presets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.provider}
            </option>
          ))}
        </select>
      </Field>

      {onDefault ? (
        <p className="-mt-2 text-pretty text-sm/6 text-muted-foreground">
          These are the registrar's own nameservers, where a new domain starts before it points at a
          host. They don't run a website or email for you.
        </p>
      ) : preset ? (
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

      <fieldset aria-describedby={`${id}-rows-hint`}>
        <legend className="text-sm font-medium text-foreground">Nameservers</legend>
        <p id={`${id}-rows-hint`} className="mt-1 text-xs text-muted-foreground">
          Two or more, one per row — exactly as your host gave them.
        </p>
        <ul className="mt-3 space-y-2.5">
          {rows.map((row, index) => (
            <li key={row.key} className="flex items-center gap-2 sm:gap-3">
              <span
                aria-hidden="true"
                className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"
              >
                <Globe className="size-5" />
              </span>
              <input
                ref={(node) => {
                  if (node) inputs.current.set(row.key, node)
                  return () => {
                    inputs.current.delete(row.key)
                  }
                }}
                type="text"
                value={row.value}
                onChange={(event) => typeInto(index, event.target.value)}
                onPaste={(event) => pasteList(index, event)}
                aria-label={`Nameserver ${index + 1}`}
                placeholder="ns.example.com"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                className={cn(inputClass, 'min-w-0 flex-1 font-mono text-base sm:text-sm')}
              />
              <button
                type="button"
                onClick={() => removeRow(index)}
                disabled={rows.length <= NAMESERVERS_MIN}
                aria-label={`Remove nameserver ${index + 1}`}
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-95 active:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:active:scale-100',
                  FOCUS,
                )}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {rows.length < NAMESERVERS_MAX ? (
          <button
            ref={addButton}
            type="button"
            onClick={addRow}
            className={cn(
              'mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-muted-foreground/40 text-sm font-medium text-foreground transition-colors hover:border-ring hover:bg-muted active:scale-[0.99] active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60',
              FOCUS,
            )}
          >
            <Plus className="size-4" aria-hidden="true" />
            Add row
          </button>
        ) : (
          <p className="mt-2.5 text-xs text-muted-foreground">
            That's the most a registry accepts: {NAMESERVERS_MAX} nameservers.
          </p>
        )}
      </fieldset>

      <div className="flex gap-2.5 rounded-xl border border-status-expiring/40 bg-status-expiring/10 p-4 text-pretty text-sm/6 text-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-expiring" aria-hidden="true" />
        <p>
          Nameserver changes usually take effect within a few hours; some networks keep the old ones
          for up to 48 hours.
        </p>
      </div>

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
            : DELIVERY_MESSAGE[data.delivery]}
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

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        {registrarDefault ? (
          <button
            type="button"
            onClick={fillDefault}
            disabled={save.isPending}
            className={cn(
              'inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto',
              FOCUS,
            )}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Use default DNS
          </button>
        ) : null}
        <SubmitButton
          pending={save.isPending}
          pendingLabel="Checking each nameserver…"
          className="sm:w-auto"
        >
          <Check className="size-4" aria-hidden="true" />
          {/* "Save" on screen; the full name for anyone reaching it out of context. */}
          <span aria-hidden="true">Save</span>
          <span className="sr-only">Save nameservers</span>
        </SubmitButton>
      </div>
    </form>
  )
}
