'use client'

import type { WebhookEvent } from '@dr/shared/mail'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { createWebhook, updateWebhook } from '../actions/webhooks'
import { EVENT_GROUPS, EVENT_WORDS } from '../lib/words'
import type { Webhook } from '../queries/webhooks'
import { SecretReveal } from './secret-reveal'

/** What a new endpoint starts with ticked: what most integrations want first. */
const STARTER: WebhookEvent[] = ['email.delivered', 'email.bounced', 'email.complained']

function readForm(form: FormData) {
  return {
    url: String(form.get('url') ?? ''),
    description: String(form.get('description') ?? ''),
    events: form.getAll('events').map(String) as WebhookEvent[],
  }
}

/**
 * Adding an endpoint, or changing one (MAIL-SPEC §6, §10): its https address,
 * a description, and the events it wants. A new endpoint's signing secret is
 * answered once, here.
 */
export function WebhookForm({
  accountId,
  webhook,
  onDone,
}: {
  accountId: string
  /** Present when editing. */
  webhook?: Webhook
  onDone?: () => void
}) {
  const id = useId()
  const router = useRouter()
  const create = useAction(createWebhook, { onSuccess: () => router.refresh() })
  const update = useAction(updateWebhook, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        router.refresh()
        onDone?.()
      }
    },
  })
  const action = webhook ? update : create
  const data = action.result.data
  const errors = action.result.validationErrors
  const urlError = fieldError(errors, 'url')
  const eventsError = fieldError(errors, 'events')
  const descriptionError = fieldError(errors, 'description')
  const created = create.result.data

  if (!webhook && created && 'secret' in created) {
    return (
      <SecretReveal secret={created.secret} title="Endpoint added" onDone={() => create.reset()} />
    )
  }

  return (
    <form
      aria-label={webhook ? `Change ${webhook.url}` : 'Add an endpoint'}
      className="space-y-5"
      noValidate
      onSubmit={onSubmitWith((form) => {
        const input = readForm(form)
        if (webhook) update.execute({ accountId, webhookId: webhook.id, ...input })
        else create.execute({ accountId, ...input })
      })}
    >
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {action.result.serverError ? (
        <FormMessage tone="error">{action.result.serverError}</FormMessage>
      ) : null}
      <Field
        id={`${id}-url`}
        label="Endpoint URL"
        error={urlError}
        hint="https only, on the public internet. We POST JSON to it."
      >
        <input
          id={`${id}-url`}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="https://example.com/webhooks/mail"
          defaultValue={webhook?.url}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={describedBy(
            `${id}-url`,
            urlError,
            'https only, on the public internet. We POST JSON to it.',
          )}
          className={inputClass}
        />
      </Field>
      <Field
        id={`${id}-description`}
        label="Description (optional)"
        error={descriptionError}
        hint="For you: which system this is, or who looks after it."
      >
        <input
          id={`${id}-description`}
          name="description"
          type="text"
          maxLength={100}
          autoComplete="off"
          defaultValue={webhook?.description ?? ''}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={describedBy(
            `${id}-description`,
            descriptionError,
            'For you: which system this is, or who looks after it.',
          )}
          className={inputClass}
        />
      </Field>
      <div className="space-y-4">
        {EVENT_GROUPS.map((group) => (
          <fieldset
            key={group.legend}
            aria-describedby={eventsError ? `${id}-events-error` : undefined}
          >
            <legend className="text-sm font-medium">{group.legend}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {group.events.map((event) => (
                <label
                  key={event}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="checkbox"
                    name="events"
                    value={event}
                    defaultChecked={
                      webhook ? webhook.events.includes(event) : STARTER.includes(event)
                    }
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{EVENT_WORDS[event].label}</span>
                    <span className="block text-xs text-muted-foreground">
                      <code className="font-mono">{event}</code> · {EVENT_WORDS[event].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {eventsError ? (
          <p id={`${id}-events-error`} className="text-sm text-tone-danger-foreground">
            {eventsError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <SubmitButton
          pending={action.isPending}
          pendingLabel={webhook ? 'Saving…' : 'Adding…'}
          className="sm:w-auto"
        >
          {webhook ? 'Save changes' : 'Add endpoint'}
        </SubmitButton>
        {webhook && onDone ? (
          <button
            type="button"
            onClick={onDone}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
