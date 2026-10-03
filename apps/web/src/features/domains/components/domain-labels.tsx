'use client'

import { Plus, Tags } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useRef, useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { createLabel, setDomainLabel } from '../actions/labels'
import { type DomainLabel, LABEL_LIMIT, sortLabels } from '../lib/labels'
import { LabelChip, LabelChips } from './label-chip'
import { colorFromForm, LabelFields } from './label-fields'
import { problemOf } from './label-manager'

/**
 * FR-P3 — the labels on one domain. Each tick saves at once and shows at
 * once; one that did not save is put back and says why. A new label can be
 * made here and goes straight onto this domain.
 */
export function DomainLabels({
  domainId,
  domainName,
  assigned,
  labels,
}: {
  domainId: string
  domainName: string
  assigned: DomainLabel[]
  /** Every label on the account. */
  labels: DomainLabel[]
}) {
  const id = useId()
  const [on, setOn] = useState(() => new Set(assigned.map((label) => label.id)))
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(labels.length === 0)
  const [problem, setProblem] = useState<string | null>(null)
  const toggle = useAction(setDomainLabel, {
    onExecute: () => setProblem(null),
    onSuccess: ({ data, input }) => {
      if (data && 'error' in data) {
        setProblem(data.error)
        flip(input.labelId, !input.on)
      }
    },
    onError: ({ error, input }) => {
      setProblem(error.serverError ?? 'That did not go through. Please try again.')
      flip(input.labelId, !input.on)
    },
  })
  const flip = (labelId: string, value: boolean) =>
    setOn((current) => {
      const next = new Set(current)
      if (value) next.add(labelId)
      else next.delete(labelId)
      return next
    })

  const shown = sortLabels(labels.filter((label) => on.has(label.id)))

  return (
    <div className="space-y-4 text-sm">
      {shown.length > 0 ? (
        <LabelChips labels={shown} />
      ) : (
        <p className="text-muted-foreground">No labels on {domainName} yet.</p>
      )}

      {problem ? <FormMessage tone="error">{problem}</FormMessage> : null}

      {labels.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={editing}
            aria-controls={`${id}-choices`}
            onClick={() => setEditing((open) => !open)}
            className={QUIET_BUTTON}
          >
            <Tags className="size-4" aria-hidden="true" />
            {editing ? 'Done' : 'Choose labels'}
          </button>
          <fieldset id={`${id}-choices`} hidden={!editing} className="mt-3">
            <legend className="sr-only">Labels on {domainName}</legend>
            <ul className="flex flex-wrap gap-2">
              {labels.map((label) => (
                <li key={label.id}>
                  <label
                    className={cn(
                      'relative inline-flex min-h-11 cursor-pointer items-center gap-2.5 rounded-full border border-border bg-background px-3.5 transition hover:bg-muted',
                      'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on.has(label.id)}
                      onChange={(event) => {
                        const value = event.target.checked
                        flip(label.id, value)
                        toggle.execute({ domainId, labelId: label.id, on: value })
                      }}
                      className="size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <LabelChip label={label} />
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </div>
      ) : null}

      {adding ? (
        <NewLabelHere
          domainId={domainId}
          onCancel={labels.length === 0 ? null : () => setAdding(false)}
          onAdded={(label) => {
            flip(label.id, true)
            setAdding(false)
          }}
        />
      ) : labels.length < LABEL_LIMIT ? (
        <button type="button" onClick={() => setAdding(true)} className={QUIET_BUTTON}>
          <Plus className="size-4" aria-hidden="true" />
          New label
        </button>
      ) : null}

      <p>
        <Link
          href="/app/settings/labels"
          className={cn('rounded font-medium text-foreground underline underline-offset-2', FOCUS)}
        >
          Manage your labels
        </Link>
      </p>
    </div>
  )
}

function NewLabelHere({
  domainId,
  onAdded,
  onCancel,
}: {
  domainId: string
  onAdded: (label: DomainLabel) => void
  /** Null when there is nothing to go back to: the account has no labels yet. */
  onCancel: (() => void) | null
}) {
  const id = useId()
  const sent = useRef('')
  const create = useAction(createLabel, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) onAdded(data.label)
    },
  })
  const problem = problemOf(create.result)

  return (
    <form
      aria-label="New label for this domain"
      noValidate
      className="space-y-4 rounded-2xl border border-border p-4"
      onSubmit={onSubmitWith((values) => {
        sent.current = String(values.get('name') ?? '').trim()
        create.execute({ name: sent.current, color: colorFromForm(values), domainId })
      })}
    >
      <LabelFields idPrefix={id} disabled={create.isPending} />
      {problem ? <FormMessage tone="error">{problem}</FormMessage> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton pending={create.isPending} pendingLabel="Adding…" className="sm:w-auto">
          Add to this domain
        </SubmitButton>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={create.isPending}
            className={QUIET_BUTTON}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
