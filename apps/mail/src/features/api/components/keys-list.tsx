'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import { StatusPill } from '@/components/common/status-pill'
import { lagosTime } from '@/features/emails/lib/format'
import type { MemberRole } from '@/lib/safe-action'
import { revokeApiKey } from '../actions/keys'
import { canRevoke, PERMISSION_LABEL } from '../lib/keys'
import type { DashboardKey, KeyDomain } from '../queries/keys'

/**
 * The account's keys (MAIL-SPEC §10): name, prefix, permission, the domain a
 * sending key is limited to, when it was made and last used — and revoke,
 * after a confirmation, for the roles SQL allows. Revoked keys are listed
 * apart, so a key that stopped working can be recognised.
 */
export function KeysList({
  accountId,
  keys,
  domains,
  memberRole,
}: {
  accountId: string
  keys: DashboardKey[]
  domains: KeyDomain[]
  memberRole: MemberRole
}) {
  const domainName = (id: string | null) =>
    id ? (domains.find((domain) => domain.id === id)?.name ?? 'a removed domain') : null
  return (
    <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
      {keys.map((key) => (
        <KeyRow
          key={key.id}
          accountId={accountId}
          apiKey={key}
          domain={domainName(key.domainId)}
          revocable={!key.revokedAt && canRevoke(memberRole, key.permission)}
        />
      ))}
    </ul>
  )
}

function KeyRow({
  accountId,
  apiKey,
  domain,
  revocable,
}: {
  accountId: string
  apiKey: DashboardKey
  domain: string | null
  revocable: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const revoke = useAction(revokeApiKey, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setOpen(false)
        router.refresh()
      }
    },
  })
  const error =
    (revoke.result.data && 'error' in revoke.result.data ? revoke.result.data.error : null) ??
    revoke.result.serverError ??
    null

  return (
    <li
      data-key={apiKey.prefix}
      className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
    >
      <div className="min-w-0 space-y-1.5">
        <p className="break-words font-medium">{apiKey.name}</p>
        <p className="font-mono text-sm text-muted-foreground">{apiKey.prefix}…</p>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={apiKey.permission === 'full' ? 'info' : 'neutral'}>
            {PERMISSION_LABEL[apiKey.permission]}
          </StatusPill>
          {domain ? <StatusPill tone="neutral">Only {domain}</StatusPill> : null}
          {apiKey.revokedAt ? <StatusPill tone="danger">Revoked</StatusPill> : null}
        </div>
        <p className="text-xs/5 text-muted-foreground">
          Made {lagosTime(apiKey.createdAt)} ·{' '}
          {apiKey.revokedAt
            ? `revoked ${lagosTime(apiKey.revokedAt)}`
            : apiKey.lastUsedAt
              ? `last used ${lagosTime(apiKey.lastUsedAt)}`
              : 'never used'}
        </p>
      </div>
      {revocable ? (
        <ConfirmDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) revoke.reset()
          }}
          trigger={
            <button
              type="button"
              aria-label={`Revoke the key ${apiKey.name}`}
              className={dangerButtonClass}
            >
              Revoke
            </button>
          }
          title={`Revoke “${apiKey.name}”?`}
          description={
            <>
              <p>
                Requests with <span className="font-mono">{apiKey.prefix}…</span> are refused from
                now on, and emails it queued that have not been sent yet will not be sent.
              </p>
              <p className="mt-2">This cannot be undone: an app using it needs a new key.</p>
            </>
          }
          confirmLabel="Revoke the key"
          pendingLabel="Revoking…"
          pending={revoke.isPending}
          error={error}
          onConfirm={() => revoke.execute({ accountId, keyId: apiKey.id })}
        />
      ) : null}
    </li>
  )
}
