'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import { FormMessage } from '@/components/common/form-parts'
import { StatusPill } from '@/components/common/status-pill'
import { deleteWebhook, rotateWebhookSecret, setWebhookEnabled } from '../actions/webhooks'
import { EVENT_WORDS } from '../lib/words'
import type { Webhook } from '../queries/webhooks'
import { SecretReveal } from './secret-reveal'
import { WebhookForm } from './webhook-form'

const when = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

const quietButton =
  'inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60'

function statusOf(webhook: Webhook) {
  if (webhook.status === 'enabled') {
    return webhook.failingSince
      ? { label: 'On, failing', tone: 'warning' as const }
      : { label: 'On', tone: 'success' as const }
  }
  return webhook.disabledReason === 'failing'
    ? { label: 'Off: kept failing', tone: 'danger' as const }
    : { label: 'Off', tone: 'neutral' as const }
}

/**
 * One endpoint (MAIL-SPEC §10 Webhooks): where it is, what it wants, its
 * secret's first characters, how it is doing — and, for those who may, the
 * changes SQL allows: edit, turn off or on, a new secret, delete.
 */
export function WebhookCard({
  accountId,
  webhook,
  canManage,
}: {
  accountId: string
  webhook: Webhook
  canManage: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null)
  const refresh = () => router.refresh()
  const toggle = useAction(setWebhookEnabled, { onSuccess: refresh })
  const rotate = useAction(rotateWebhookSecret, {
    onSuccess: ({ data }) => {
      if (data && 'secret' in data) {
        setConfirm(null)
        refresh()
      }
    },
  })
  const remove = useAction(deleteWebhook, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setConfirm(null)
        refresh()
      }
    },
  })
  const status = statusOf(webhook)
  const errorOf = (result: { data?: unknown; serverError?: string }) =>
    (result.data && typeof result.data === 'object' && 'error' in result.data
      ? String((result.data as { error: string }).error)
      : null) ??
    result.serverError ??
    null
  const toggleError = errorOf(toggle.result)
  const newSecret =
    rotate.result.data && 'secret' in rotate.result.data ? rotate.result.data.secret : null

  return (
    <li data-webhook={webhook.url} className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-sm font-medium">{webhook.url}</p>
          {webhook.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{webhook.description}</p>
          ) : null}
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Events</dt>
        <dd>
          <ul className="flex flex-wrap gap-1.5">
            {webhook.events.map((event) => (
              <li
                key={event}
                className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium"
                title={event}
              >
                {EVENT_WORDS[event].label}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted-foreground">Signing secret</dt>
        <dd className="font-mono text-xs">{webhook.secretHint}…</dd>
        {webhook.lastSuccessAt ? (
          <>
            <dt className="text-muted-foreground">Last delivered</dt>
            <dd>{when.format(new Date(webhook.lastSuccessAt))}</dd>
          </>
        ) : null}
        {webhook.status === 'enabled' && webhook.failingSince ? (
          <>
            <dt className="text-muted-foreground">Failing since</dt>
            <dd>
              {when.format(new Date(webhook.failingSince))}. After three days without a 2xx answer
              it is turned off.
            </dd>
          </>
        ) : null}
        {webhook.status === 'disabled' && webhook.disabledAt ? (
          <>
            <dt className="text-muted-foreground">Turned off</dt>
            <dd>
              {when.format(new Date(webhook.disabledAt))}
              {webhook.disabledReason === 'failing'
                ? ': it answered nothing but errors for three days. Fix it, then turn it back on.'
                : '.'}
            </dd>
          </>
        ) : null}
      </dl>

      {newSecret ? (
        <SecretReveal
          secret={newSecret}
          title="New signing secret made"
          onDone={() => rotate.reset()}
        />
      ) : null}

      {canManage && editing ? (
        <div className="rounded-2xl border border-border bg-background p-4 sm:p-5">
          <WebhookForm accountId={accountId} webhook={webhook} onDone={() => setEditing(false)} />
        </div>
      ) : null}

      {canManage && !editing ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button type="button" className={quietButton} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={toggle.isPending}
            aria-busy={toggle.isPending || undefined}
            onClick={() =>
              toggle.execute({
                accountId,
                webhookId: webhook.id,
                enabled: webhook.status !== 'enabled',
              })
            }
          >
            {webhook.status === 'enabled' ? 'Turn off' : 'Turn on'}
          </button>
          <ConfirmDialog
            open={confirm === 'rotate'}
            onOpenChange={(open) => {
              if (!open) rotate.reset()
              setConfirm(open ? 'rotate' : null)
            }}
            trigger={
              <button type="button" className={quietButton}>
                New secret
              </button>
            }
            title="Make a new signing secret?"
            description="The old secret stops signing at once: deliveries from now on are signed with the new one, so update your endpoint straight after."
            confirmLabel="Make a new secret"
            pendingLabel="Making…"
            pending={rotate.isPending}
            error={errorOf(rotate.result)}
            onConfirm={() => rotate.execute({ accountId, webhookId: webhook.id })}
          />
          <ConfirmDialog
            open={confirm === 'delete'}
            onOpenChange={(open) => {
              if (!open) remove.reset()
              setConfirm(open ? 'delete' : null)
            }}
            trigger={
              <button type="button" className={dangerButtonClass}>
                Delete
              </button>
            }
            title="Delete this endpoint?"
            description="Nothing more is sent to it, and its delivery history goes with it. This cannot be undone."
            confirmLabel="Delete the endpoint"
            pendingLabel="Deleting…"
            pending={remove.isPending}
            error={errorOf(remove.result)}
            onConfirm={() => remove.execute({ accountId, webhookId: webhook.id })}
          />
        </div>
      ) : null}
      {toggleError ? <FormMessage tone="error">{toggleError}</FormMessage> : null}
    </li>
  )
}
