'use client'

import { BookUser, Pencil, Plus, Star, Trash2 } from 'lucide-react'
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
import { FOCUS, PANEL, PANEL_HEADING } from '@/components/layout/panel'
import { RegistrantFields } from '@/features/checkout/components/registrant-fields'
import { registrantFromForm } from '@/features/checkout/lib/contact'
import { RegistrantSummary } from '@/features/domains/components/registrant-summary'
import { QUIET_BUTTON } from '@/features/domains/components/settings-parts'
import { cn } from '@/lib/utils'
import {
  deleteContactProfile,
  makeDefaultContactProfile,
  saveContactProfile,
} from '../actions/profiles'
import { errorAt } from '../lib/errors'
import type { ContactProfile } from '../lib/profiles'

type Result = {
  data?: { ok: true } | { error: string } | undefined
  serverError?: string | undefined
  validationErrors?: unknown
}

const AGAIN = 'That did not go through. Please try again.'

/** What went wrong with a request, from its answer or the server; null when it went through. */
function problemOf(result: Result): string | null {
  if (result.serverError) return result.serverError
  return result.data && 'error' in result.data ? result.data.error : null
}

/**
 * FR-A4 — the account's saved contacts: add, edit, name, delete, and pick
 * the default. Each list change comes back from the server (the action
 * revalidates this page), so what shows is what is saved.
 */
export function ContactProfiles({ profiles }: { profiles: ContactProfile[] }) {
  /** A profile's id while it is being edited, or 'new'. */
  const [editing, setEditing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const open = (target: string) => {
    setEditing(target)
    setNotice(null)
  }
  const done = (message: string) => {
    setEditing(null)
    setNotice(message)
  }

  return (
    <div className="space-y-4">
      {notice ? <FormMessage tone="success">{notice}</FormMessage> : null}

      {editing === 'new' ? (
        <section aria-labelledby="new-contact-heading" className={cn(PANEL, 'p-5 sm:p-7')}>
          <h2 id="new-contact-heading" className={PANEL_HEADING}>
            New contact
          </h2>
          <div className="mt-5">
            <ProfileForm
              isFirst={profiles.length === 0}
              onDone={done}
              onCancel={() => setEditing(null)}
            />
          </div>
        </section>
      ) : profiles.length === 0 ? (
        <section
          aria-labelledby="no-contacts-heading"
          className={cn(PANEL, 'flex flex-col items-start gap-4 p-5 sm:p-7')}
        >
          <BookUser className="size-6 text-muted-foreground" aria-hidden="true" />
          <div>
            <h2 id="no-contacts-heading" className={PANEL_HEADING}>
              No saved contacts yet
            </h2>
            <p className="mt-1.5 max-w-xl text-pretty text-sm/6 text-muted-foreground">
              Your first checkout saves the registrant you use here. Add others to pick them as a
              domain’s administrative, technical or billing contact.
            </p>
          </div>
          <AddButton onClick={() => open('new')} />
        </section>
      ) : (
        <AddButton onClick={() => open('new')} />
      )}

      {profiles.length > 0 ? (
        <ul aria-label="Saved contacts" className="grid gap-4 lg:grid-cols-2">
          {profiles.map((profile) => (
            <li key={profile.id} className={cn(PANEL, 'p-5 sm:p-6')}>
              {editing === profile.id ? (
                <ProfileForm profile={profile} onDone={done} onCancel={() => setEditing(null)} />
              ) : (
                <ProfileCard
                  profile={profile}
                  onEdit={() => open(profile.id)}
                  onChanged={(message) => done(message)}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
        FOCUS,
      )}
    >
      <Plus className="size-4" aria-hidden="true" />
      Add a contact
    </button>
  )
}

/** One saved contact: who it is, and what can be done with it. */
function ProfileCard({
  profile,
  onEdit,
  onChanged,
}: {
  profile: ContactProfile
  onEdit: () => void
  onChanged: (message: string) => void
}) {
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const remove = useAction(deleteContactProfile)
  const makeDefault = useAction(makeDefaultContactProfile)
  const busy = remove.isPending || makeDefault.isPending

  /**
   * Awaited rather than left to the hook's callbacks: a deleted profile's
   * card is gone once the list comes back, and its callbacks with it — the
   * page, which stays, says it was done.
   */
  const run = async (request: () => Promise<Result | undefined>, message: string) => {
    setProblem(null)
    try {
      const result = await request()
      const failed = result ? problemOf(result) : null
      if (failed) setProblem(failed)
      else if (result?.validationErrors) setProblem(AGAIN)
      else onChanged(message)
    } catch {
      setProblem(AGAIN)
    }
  }

  return (
    <article aria-labelledby={`${id}-label`} className="flex h-full flex-col text-sm/6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-label`} className={cn(PANEL_HEADING, 'min-w-0 break-words')}>
          {profile.label}
        </h2>
        {profile.isDefault ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2.5 py-0.5 text-xs font-medium text-foreground">
            <Star className="size-3" aria-hidden="true" />
            Default
          </span>
        ) : null}
      </div>
      <RegistrantSummary registrant={profile.values} className="mt-2 text-muted-foreground" />
      {profile.isDefault ? (
        <p className="mt-2 text-muted-foreground">Checkout fills in the registrant from it.</p>
      ) : null}

      {problem ? (
        <FormMessage tone="error" className="mt-4">
          {problem}
        </FormMessage>
      ) : null}

      {confirming ? (
        <fieldset className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <legend className="sr-only">Delete “{profile.label}”?</legend>
          <p aria-hidden="true" className="font-medium text-foreground">
            Delete “{profile.label}”?
          </p>
          <p className="text-pretty text-muted-foreground">
            Orders and domains that used it keep their own copy of the details.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              aria-busy={remove.isPending || undefined}
              onClick={() =>
                run(() => remove.executeAsync({ id: profile.id }), `Deleted “${profile.label}”.`)
              }
              className={cn(
                QUIET_BUTTON,
                'border-destructive text-destructive hover:bg-destructive/10',
              )}
            >
              {remove.isPending ? 'Deleting…' : 'Delete contact'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className={QUIET_BUTTON}
            >
              Keep it
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="mt-auto flex flex-wrap gap-2 pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Edit ${profile.label}`}
            className={QUIET_BUTTON}
          >
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </button>
          {profile.isDefault ? null : (
            <button
              type="button"
              disabled={busy}
              aria-busy={makeDefault.isPending || undefined}
              onClick={() =>
                run(
                  () => makeDefault.executeAsync({ id: profile.id }),
                  `“${profile.label}” is now your default contact.`,
                )
              }
              aria-label={`Make ${profile.label} the default`}
              className={QUIET_BUTTON}
            >
              <Star className="size-4" aria-hidden="true" />
              {makeDefault.isPending ? 'Saving…' : 'Make default'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setProblem(null)
              setConfirming(true)
            }}
            aria-label={`Delete ${profile.label}`}
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

/** Adds a contact, or edits one, with the registrant's own fields and checks (FR-A4). */
function ProfileForm({
  profile,
  isFirst = false,
  onDone,
  onCancel,
}: {
  profile?: ContactProfile
  /** The account's first contact: it becomes the default unless unticked. */
  isFirst?: boolean
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const id = useId()
  /** The name as submitted, for the message once it is saved. */
  const sent = useRef('')
  const save = useAction(saveContactProfile, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) onDone(`Saved “${sent.current}”.`)
    },
  })
  const errors = save.result.validationErrors
  const problem = problemOf(save.result)
  const labelError = errorAt(errors, ['label'])

  return (
    <form
      aria-label={profile ? `Edit ${profile.label}` : 'New contact'}
      noValidate
      className="space-y-5"
      onSubmit={onSubmitWith((form) => {
        sent.current = String(form.get('label') ?? '').trim()
        save.execute({
          ...(profile ? { id: profile.id } : {}),
          label: sent.current,
          contact: registrantFromForm(form),
          isDefault: form.get('isDefault') === 'on',
        })
      })}
    >
      <Field
        id={`${id}-label`}
        label="Name for this contact"
        error={labelError}
        hint="Only you see it — for example “Office” or “Accounts”."
      >
        <input
          id={`${id}-label`}
          name="label"
          defaultValue={profile?.label ?? ''}
          maxLength={64}
          aria-invalid={labelError ? true : undefined}
          aria-describedby={describedBy(`${id}-label`, labelError, 'hint')}
          className={inputClass}
        />
      </Field>

      <RegistrantFields
        idPrefix={id}
        registrant={profile?.values ?? { country: 'NG', phoneCountryCode: '234' }}
        errorFor={(name) => errorAt(errors, ['contact', name])}
      />

      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm/6">
        <input
          type="checkbox"
          name="isDefault"
          defaultChecked={profile ? profile.isDefault : isFirst}
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
        />
        <span className="text-foreground">
          Use as my default — checkout fills in the registrant from it, and saves the registrant you
          use back to it.
        </span>
      </label>

      {problem ? <FormMessage tone="error">{problem}</FormMessage> : null}
      {errors ? (
        <FormMessage tone="error">Some details need fixing — they’re marked above.</FormMessage>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton pending={save.isPending} pendingLabel="Saving…" className="sm:w-auto">
          Save contact
        </SubmitButton>
        <button type="button" onClick={onCancel} disabled={save.isPending} className={QUIET_BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  )
}
