'use client'

import { RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import {
  checkPresetDraft,
  discardPresetDraft,
  hidePreset,
  publishPresetDraft,
  showPreset,
} from '@/features/admin/actions/presets'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import {
  discardCopy,
  hideCopy,
  PRESET_COPY,
  publishCopy,
  showCopy,
} from '@/features/admin/lib/settings-copy'
import { checkResultWords } from '@/features/admin/lib/settings-presets'
import type { AdminSide } from '@/features/admin/lib/side'

/**
 * A preset's buttons (docs/ADMIN-SPEC.md §5.2 B13, D21). Hide is an
 * operator's and asks nothing more; Show again, Publish and Save are the
 * owner's and money tier — a reason and the authenticator code. Check now
 * asks the gateway to look the draft's hosts up in public DNS and record
 * the verdict on the draft. SQL decides who may each time.
 */

const list = (hosts: string[]) => (hosts.length === 0 ? 'Per domain' : hosts.join(', '))

export function VisibilityActions({
  preset,
  domains,
  side,
  returnTo,
}: {
  preset: { id: string; provider: string; isHidden: boolean }
  /** Domains on it on this side (admin_preset_usage); null when it could not be read. */
  domains: number | null
  side: AdminSide
  returnTo: string
}) {
  if (preset.isHidden) {
    const copy = showCopy(preset.provider)
    return (
      <ConfirmAction
        trigger={`Show ${preset.provider} again`}
        title={copy.title}
        body={copy.body}
        confirmLabel={PRESET_COPY.showConfirm}
        reason="required"
        needsCode
        returnTo={returnTo}
        successMessage={PRESET_COPY.showDone}
        run={async ({ reason, requestKey, code }) =>
          adminOutcome(
            await showPreset({
              presetId: preset.id,
              reason: reason ?? '',
              requestKey,
              code: code ?? '',
            }),
          )
        }
      />
    )
  }
  const copy = hideCopy(preset.provider, domains, side)
  return (
    <ConfirmAction
      trigger={`Hide ${preset.provider}`}
      title={copy.title}
      body={copy.body}
      confirmLabel={PRESET_COPY.hideConfirm}
      reason="optional"
      destructive
      returnTo={returnTo}
      successMessage={PRESET_COPY.hideDone}
      run={async ({ reason, requestKey }) =>
        adminOutcome(
          await hidePreset({ presetId: preset.id, requestKey, ...(reason ? { reason } : {}) }),
        )
      }
    />
  )
}

export function DraftActions({
  draft,
  before,
  publishable,
  checkable,
  lastCheck,
  returnTo,
}: {
  draft: { id: string; provider: string; nameservers: string[] }
  /** The live preset's nameservers; null for a new host. */
  before: string[] | null
  /** A check passed after it was saved, or there is nothing to check. */
  publishable: boolean
  /** It has nameservers to look up. */
  checkable: boolean
  lastCheck: string
  returnTo: string
}) {
  const publish = publishCopy(draft.provider)
  const discard = discardCopy(draft.provider)
  return (
    <div className="space-y-4">
      {checkable ? <CheckNow draftId={draft.id} returnTo={returnTo} /> : null}
      <div className="flex flex-wrap gap-3">
        <ConfirmAction
          trigger={`Publish ${draft.provider}'s draft`}
          disabled={!publishable}
          title={publish.title}
          rows={[
            { label: 'Before', value: before === null ? 'A new host' : list(before) },
            { label: 'After', value: list(draft.nameservers) },
            { label: 'Last check', value: lastCheck },
          ]}
          body={publish.body}
          confirmLabel={PRESET_COPY.publishConfirm}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={PRESET_COPY.publishDone}
          run={async ({ reason, requestKey, code }) =>
            adminOutcome(
              await publishPresetDraft({
                draftId: draft.id,
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
        <ConfirmAction
          trigger="Discard draft"
          title={discard.title}
          body={discard.body}
          confirmLabel={PRESET_COPY.discardConfirm}
          reason="optional"
          destructive
          returnTo={returnTo}
          successMessage={PRESET_COPY.discardDone}
          run={async ({ reason, requestKey }) =>
            adminOutcome(
              await discardPresetDraft({
                draftId: draft.id,
                requestKey,
                ...(reason ? { reason } : {}),
              }),
            )
          }
        />
      </div>
      {publishable ? null : (
        <p className="text-sm text-muted-foreground">
          Publish opens once a check passes after the draft was saved.
        </p>
      )}
    </div>
  )
}

/** Check now: the gateway reads each host from public resolvers and records the verdict. */
function CheckNow({ draftId, returnTo }: { draftId: string; returnTo: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<{ ok: boolean; words: string } | null>(null)

  async function onCheck() {
    if (pending) return
    setPending(true)
    setError(null)
    setChecked(null)
    try {
      const result = adminOutcome(await checkPresetDraft({ draftId }))
      if (result.ok && result.data) {
        setChecked({ ok: result.data.ok, words: checkResultWords(result.data) })
        router.refresh()
      } else if (!result.ok) {
        setError(result.message)
      }
    } catch {
      setError("We couldn't reach the dashboard's server. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onCheck}
        disabled={pending}
        aria-busy={pending || undefined}
        className={QUIET_BUTTON}
      >
        {pending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        {pending ? 'Checking in public DNS…' : PRESET_COPY.checkNow}
      </button>
      <ActionError message={error} returnTo={returnTo} />
      {checked ? (
        <FormMessage tone={checked.ok ? 'success' : 'error'}>{checked.words}</FormMessage>
      ) : null}
    </div>
  )
}
