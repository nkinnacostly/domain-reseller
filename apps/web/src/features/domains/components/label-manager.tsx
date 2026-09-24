'use client'

import { Pencil, Tags, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useRef, useState } from 'react'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { FOCUS, PANEL, PANEL_HEADING } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { createLabel, deleteLabel, updateLabel } from '../actions/labels'
import { LABEL_LIMIT, type LabelColor } from '../lib/labels'
import { portfolioHref } from '../lib/portfolio'
import type { LabelWithCount } from '../queries/labels'
import { LabelChip } from './label-chip'
import { colorFromForm, LabelFields } from './label-fields'
import { QUIET_BUTTON } from './settings-parts'

type Answer = {
  data?: { ok: true } | { error: string } | undefined
  serverError?: string | undefined
  validationErrors?: unknown
}

const AGAIN = 'That did not go through. Please try again.'

/** What went wrong with a request, or null when it went through. */
export function problemOf(result: Answer): string | null {
  if (result.serverError) return result.serverError
  if (result.data && 'error' in result.data) return result.data.error
  if (result.validationErrors) return nameError(result.validationErrors) ?? AGAIN
  return null
}

/** The label name's own message from a schema refusal, e.g. "Keep it to 30 characters." */
function nameError(errors: unknown): string | undefined {
  return (errors as { name?: { _errors?: string[] } } | undefined)?.name?._errors?.[0]
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * FR-P3 — the account's labels: add, rename, recolour, delete. Every change
 * comes back from the server (the actions revalidate this page), so what
 * shows is what is saved.
 */
export function LabelManager({ labels }: { labels: LabelWithCount[] }) {
  const [notice, setNotice] = useState<string | null>(null)
  const full = labels.length >= LABEL_LIMIT

  return (
    <div className="space-y-4">
      {notice ? <FormMessage tone="success">{notice}</FormMessage> : null}

      <section aria-labelledby="new-label-heading" className={cn(PANEL, 'p-5 sm:p-7')}>
        <h2 id="new-label-heading" className={PANEL_HEADING}>
          New label
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          {full
            ? `You have ${LABEL_LIMIT} labels, the most an account can have. Delete one to add another.`
            : `Only you see your labels. You have ${plural(labels.length, 'label', 'labels')} of ${LABEL_LIMIT}.`}
        </p>
        {full ? null : (
          <div className="mt-5">
            <NewLabelForm onDone={setNotice} />
          </div>
        )}
      </section>

      {labels.length === 0 ? (
        <section
          aria-labelledby="no-labels-heading"
          className={cn(PANEL, 'flex flex-col items-start gap-3 p-5 sm:p-7')}
        >
          <Tags className="size-6 text-muted-foreground" aria-hidden="true" />
          <h2 id="no-labels-heading" className={PANEL_HEADING}>
            No labels yet
          </h2>
          <p className="max-w-xl text-pretty text-sm/6 text-muted-foreground">
            Group your domains by client, project or anything else. Put a label on a domain from its
            page, or on many at once from your domains list — then filter the list by it.
          </p>
        </section>
      ) : (
        <ul aria-label="Your labels" className="grid gap-4 lg:grid-cols-2">
          {labels.map((label) => (
            <li key={label.id} className={cn(PANEL, 'p-5 sm:p-6')}>
              <LabelCard label={label} onDone={setNotice} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NewLabelForm({ onDone }: { onDone: (message: string) => void }) {
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const sent = useRef('')
  const create = useAction(createLabel, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        form.current?.reset()
        onDone(`Added “${sent.current}”.`)
      }
    },
  })
  const problem = problemOf(create.result)

  return (
    <form
      ref={form}
      aria-label="New label"
      noValidate
      className="space-y-5"
      onSubmit={onSubmitWith((values) => {
        sent.current = String(values.get('name') ?? '').trim()
        create.execute({ name: sent.current, color: colorFromForm(values) })
      })}
    >
      <LabelFields idPrefix={id} disabled={create.isPending} />
      {problem ? <FormMessage tone="error">{problem}</FormMessage> : null}
      <SubmitButton pending={create.isPending} pendingLabel="Adding…" className="sm:w-auto">
        Add label
      </SubmitButton>
    </form>
  )
}

/** One label: how it looks, where it is used, and what can be done with it. */
function LabelCard({
  label,
  onDone,
}: {
  label: LabelWithCount
  onDone: (message: string) => void
}) {
  const id = useId()
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const sent = useRef<{ name: string; color: LabelColor }>({ name: label.name, color: label.color })
  const update = useAction(updateLabel, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setMode('view')
        onDone(`Saved “${sent.current.name}”.`)
      }
    },
  })
  const [problem, setProblem] = useState<string | null>(null)
  const remove = useAction(deleteLabel)

  /**
   * Awaited rather than left to the hook's callbacks: a deleted label's card
   * is gone once the list comes back, and its callbacks with it.
   */
  const confirmDelete = async () => {
    setProblem(null)
    try {
      const result = await remove.executeAsync({ id: label.id })
      const failed = result ? problemOf(result) : AGAIN
      if (failed) setProblem(failed)
      else onDone(`Deleted “${label.name}”.`)
    } catch {
      setProblem(AGAIN)
    }
  }

  if (mode === 'edit') {
    const editProblem = problemOf(update.result)
    return (
      <form
        aria-label={`Edit ${label.name}`}
        noValidate
        className="space-y-5"
        onSubmit={onSubmitWith((values) => {
          sent.current = {
            name: String(values.get('name') ?? '').trim(),
            color: colorFromForm(values),
          }
          update.execute({ id: label.id, ...sent.current })
        })}
      >
        <LabelFields
          idPrefix={id}
          name={label.name}
          color={label.color}
          disabled={update.isPending}
        />
        {editProblem ? <FormMessage tone="error">{editProblem}</FormMessage> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <SubmitButton pending={update.isPending} pendingLabel="Saving…" className="sm:w-auto">
            Save label
          </SubmitButton>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => {
              update.reset()
              setMode('view')
            }}
            className={QUIET_BUTTON}
          >
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <article aria-labelledby={`${id}-name`} className="flex h-full flex-col gap-3 text-sm/6">
      <h3 id={`${id}-name`} className="min-w-0">
        <LabelChip label={label} className="text-sm" />
      </h3>
      <p className="text-muted-foreground">
        {label.domainCount === 0 ? (
          'Not on any domain yet.'
        ) : (
          <>
            On {plural(label.domainCount, 'domain', 'domains')}.{' '}
            <Link
              href={portfolioHref({ labelId: label.id })}
              className={cn(
                'rounded font-medium text-foreground underline underline-offset-2',
                FOCUS,
              )}
            >
              Show {label.domainCount === 1 ? 'it' : 'them'}
              <span className="sr-only"> — domains labelled {label.name}</span>
            </Link>
          </>
        )}
      </p>

      {problem ? <FormMessage tone="error">{problem}</FormMessage> : null}

      {mode === 'delete' ? (
        <fieldset className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <legend className="sr-only">Delete “{label.name}”?</legend>
          <p aria-hidden="true" className="font-medium text-foreground">
            Delete “{label.name}”?
          </p>
          <p className="text-pretty text-muted-foreground">
            {label.domainCount === 0
              ? 'It is not on any domain.'
              : `It comes off ${plural(label.domainCount, 'domain', 'domains')}. The domains themselves are not changed.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={confirmDelete}
              className={cn(
                QUIET_BUTTON,
                'border-destructive text-destructive hover:bg-destructive/10',
              )}
            >
              {remove.isPending ? 'Deleting…' : 'Delete label'}
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => setMode('view')}
              className={QUIET_BUTTON}
            >
              Keep it
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setProblem(null)
              setMode('edit')
            }}
            aria-label={`Edit ${label.name}`}
            className={QUIET_BUTTON}
          >
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              setProblem(null)
              setMode('delete')
            }}
            aria-label={`Delete ${label.name}`}
            className={QUIET_BUTTON}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
    </article>
  )
}
