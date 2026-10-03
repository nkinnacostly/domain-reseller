'use client'

import type { AdminCatalogueApply, AdminCataloguePreview } from '@dr/shared/admin'
import { Eye } from 'lucide-react'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import {
  applyPriceList,
  applySslList,
  previewPriceList,
  previewSslList,
} from '@/features/admin/actions/supplier'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { formatWat } from '@/features/admin/lib/format'
import {
  applySummary,
  type CatalogueKind,
  previewSummary,
  reportBlocks,
} from '@/features/admin/lib/supplier-catalogue'
import { APPLY_PRICE_LIST, APPLY_SSL_LIST } from '@/features/admin/lib/supplier-copy'

/**
 * One price list's preview and apply (docs/ADMIN-SPEC.md §5.2 B6, D19). The
 * preview runs the weekly sync without writing and shows its own report;
 * applying runs it now (money tier: the dialog asks for the authenticator
 * code), and the site's prices are expired so they update on the next
 * refresh. Both are the owner's, and both are audited.
 */
export function CataloguePanel({ kind, mayApply }: { kind: CatalogueKind; mayApply: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ data: AdminCataloguePreview; auditId: number } | null>(
    null,
  )
  const [applied, setApplied] = useState<AdminCatalogueApply | null>(null)
  const copy = kind === 'tlds' ? APPLY_PRICE_LIST : APPLY_SSL_LIST

  async function onPreview() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome(
        kind === 'tlds' ? await previewPriceList({}) : await previewSslList({}),
      )
      if (result.ok && result.data) setPreview({ data: result.data, auditId: result.auditId })
      else if (!result.ok) setError(result.message)
    } catch {
      setError("We couldn't reach the dashboard's server. Try again.")
    } finally {
      setPending(false)
    }
  }

  const summary = preview ? previewSummary(preview.data) : null
  const blocks = preview ? reportBlocks(preview.data.report) : []
  const outcome = applied ? applySummary(applied) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={pending}
          aria-busy={pending || undefined}
          className={QUIET_BUTTON}
        >
          {pending ? (
            <Spinner className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
          {pending ? 'Reading the listing… this can take a minute' : 'Preview changes'}
        </button>
        {mayApply ? (
          <ConfirmAction
            trigger={copy.confirm}
            title={copy.title}
            body={copy.body}
            {...(summary
              ? {
                  rows: [
                    {
                      label: 'Last preview',
                      value: `${summary.counts} (${formatWat(preview?.data.readAt)})`,
                    },
                  ],
                }
              : {})}
            confirmLabel={copy.confirm}
            cancelLabel={copy.cancel}
            reason="optional"
            needsCode
            returnTo="/admin/supplier/catalogue"
            successMessage={copy.done}
            run={async ({ reason, requestKey, code }) => {
              const input = { requestKey, code: code ?? '', ...(reason ? { reason } : {}) }
              const result = adminOutcome(
                kind === 'tlds' ? await applyPriceList(input) : await applySslList(input),
              )
              if (result.ok && result.data) {
                setApplied(result.data)
                setPreview(null)
              }
              return result
            }}
          />
        ) : null}
      </div>

      <ActionError message={error} returnTo="/admin/supplier/catalogue" />

      {outcome ? (
        <FormMessage tone={outcome.ok ? 'success' : 'error'}>{outcome.words}</FormMessage>
      ) : null}

      {preview && summary ? (
        <section aria-label="Preview" className="space-y-3" data-preview={kind}>
          <div className="flex flex-wrap items-center gap-2">
            <AdminStatusPill
              value={summary.tone}
              tone={summary.tone}
              labels={{
                ok: 'Up to date',
                info: 'Changes waiting',
                warning: 'Would be refused',
                danger: "Couldn't be read",
              }}
            />
            <span className="text-sm text-muted-foreground tabular-nums">{summary.counts}</span>
          </div>
          <p role="status" className="text-sm text-foreground">
            {summary.headline}{' '}
            <span className="text-muted-foreground">
              Read {formatWat(preview.data.readAt)} · audit entry #{preview.auditId}
            </span>
          </p>
          {blocks.length > 0 ? (
            <div className="relative max-h-96 overflow-auto rounded-2xl border border-border bg-background/70 p-4">
              {blocks.map((block, index) => (
                // The report has no ids: its blocks are in order and never move.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <div key={index} className="mb-3 last:mb-0">
                  <p className="text-sm font-medium break-words text-foreground">{block.lead}</p>
                  {block.lines.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 font-mono text-xs break-words text-muted-foreground">
                      {block.lines.map((line, at) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: report lines repeat and never move
                        <li key={at}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
