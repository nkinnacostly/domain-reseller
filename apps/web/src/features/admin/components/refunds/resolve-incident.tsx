'use client'

import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { useId, useState } from 'react'
import { inputClass } from '@/components/common/form-parts'
import { resolveIncident, resolveMoneyIncident } from '@/features/admin/actions/incidents'
import { ConfirmAction, type ConfirmRow } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { formatWat } from '@/features/admin/lib/format'
import {
  CHECK_STEP,
  HANDLED_OUTSIDE_CHECK,
  INCIDENT_KIND_LABEL,
  naira,
  OUTCOME_LABEL,
  RESOLVE_COPY,
} from '@/features/admin/lib/refunds-copy'
import { checkProblems, type IncidentOutcome } from '@/features/admin/lib/refunds-rules'
import { cn } from '@/lib/utils'
import { FlwCheck, useNow } from './flw-check'

/**
 * "Mark resolved" for one payment incident (ADMIN-SPEC §5.2 B3). Where
 * nothing is owed it records that someone looked. Where money is owed it is
 * a money action: inside the dialog the person says what settled it — a
 * payment now recorded, a refund that completed, a Flutterwave refund
 * checked from there, or (the owner) handled outside — and the wrapper
 * checks that evidence against the records before it marks anything
 * resolved.
 */

export type ResolvableIncident = {
  id: number
  kind: string
  owed: boolean
  orderNumber: string | null
  providerReference: string | null
  completedRefunds: { id: string; amountKobo: number; completedAt: string | null }[]
}

const RADIO_ROW =
  'flex min-h-11 items-start gap-3 rounded-xl border border-border px-3.5 py-2.5 text-sm text-foreground has-[:checked]:border-brand has-[:disabled]:opacity-60'

export function ResolveIncident({
  incident,
  outcomes,
}: {
  incident: ResolvableIncident
  /** The outcomes this admin may choose (owed kinds only). */
  outcomes: IncidentOutcome[]
}) {
  const id = useId()
  const [outcome, setOutcome] = useState<IncidentOutcome | null>(null)
  const [refundId, setRefundId] = useState<string | null>(incident.completedRefunds[0]?.id ?? null)
  const [check, setCheck] = useState<AdminFlwRefundCheck | null>(null)
  const now = useNow(check !== null)
  const returnTo = `/admin/refunds/incidents#incident-${incident.id}`
  const kind = INCIDENT_KIND_LABEL[incident.kind] ?? incident.kind.replace(/_/g, ' ')
  const rows: ConfirmRow[] = [
    { label: 'Incident', value: kind },
    { label: 'Order', value: incident.orderNumber ?? 'No order' },
  ]

  if (!incident.owed) {
    return (
      <ConfirmAction
        trigger={RESOLVE_COPY.confirmLabel}
        title={RESOLVE_COPY.title}
        rows={rows}
        body={RESOLVE_COPY.reviewed}
        confirmLabel={RESOLVE_COPY.confirmLabel}
        cancelLabel={RESOLVE_COPY.cancelLabel}
        reason="required"
        returnTo={returnTo}
        successMessage={RESOLVE_COPY.success}
        run={async ({ reason, requestKey }) =>
          adminOutcome(
            await resolveIncident({ incidentId: incident.id, reason: reason ?? '', requestKey }),
          )
        }
      />
    )
  }

  const problems = check
    ? checkProblems(check, { transactionId: incident.providerReference }, now)
    : []
  const ready = (() => {
    switch (outcome) {
      case 'payment_recorded':
      case 'handled_outside':
        return true
      case 'refund_completed':
        return incident.completedRefunds.some((refund) => refund.id === refundId)
      case 'flw_refund_verified':
        return check !== null && problems.length === 0
      default:
        return false
    }
  })()
  const notReady =
    outcome === null
      ? RESOLVE_COPY.chooseFirst
      : outcome === 'refund_completed'
        ? RESOLVE_COPY.noCompletedRefund
        : CHECK_STEP.needsCheck

  return (
    <ConfirmAction
      trigger={RESOLVE_COPY.confirmLabel}
      title={RESOLVE_COPY.title}
      rows={rows}
      body={RESOLVE_COPY.owed}
      checks={outcome === 'handled_outside' ? [HANDLED_OUTSIDE_CHECK] : []}
      confirmLabel={RESOLVE_COPY.confirmLabel}
      cancelLabel={RESOLVE_COPY.cancelLabel}
      reason="required"
      needsCode
      canConfirm={ready}
      notReadyHint={notReady}
      returnTo={returnTo}
      successMessage={RESOLVE_COPY.success}
      run={async ({ reason, requestKey, code, checks }) => {
        if (!outcome)
          return { ok: false, code: 'OUTCOME_REQUIRED', message: RESOLVE_COPY.chooseFirst }
        return adminOutcome(
          await resolveMoneyIncident({
            incidentId: incident.id,
            outcome,
            ...(outcome === 'refund_completed' && refundId ? { refundId } : {}),
            ...(outcome === 'flw_refund_verified' && check ? { checkId: check.checkId } : {}),
            confirmed: Boolean(checks[HANDLED_OUTSIDE_CHECK.id]),
            reason: reason ?? '',
            requestKey,
            code: code ?? '',
          }),
        )
      }}
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-foreground">
          {RESOLVE_COPY.outcomeLegend}
        </legend>
        {outcomes.map((value) => {
          const none = value === 'refund_completed' && incident.completedRefunds.length === 0
          return (
            <label key={value} className={RADIO_ROW}>
              <input
                type="radio"
                name={`${id}-outcome`}
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
                disabled={none}
                className="mt-0.5 size-5 shrink-0 accent-brand"
              />
              <span>
                {OUTCOME_LABEL[value]}
                {value === 'handled_outside' ? (
                  <span className="text-muted-foreground"> ({RESOLVE_COPY.ownerOnly})</span>
                ) : null}
                {none ? (
                  <span className="block text-xs text-muted-foreground">
                    {RESOLVE_COPY.noCompletedRefund}
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}
      </fieldset>

      {outcome === 'refund_completed' && incident.completedRefunds.length > 1 ? (
        <div>
          <label htmlFor={`${id}-refund`} className="text-sm font-medium text-foreground">
            {RESOLVE_COPY.pickRefund}
          </label>
          <select
            id={`${id}-refund`}
            value={refundId ?? ''}
            onChange={(event) => setRefundId(event.target.value)}
            className={cn(inputClass, 'mt-1.5 sm:w-80')}
          >
            {incident.completedRefunds.map((refund) => (
              <option key={refund.id} value={refund.id}>
                {naira(refund.amountKobo)} · {formatWat(refund.completedAt)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {outcome === 'flw_refund_verified' ? (
        <FlwCheck
          target={{ incidentId: incident.id }}
          targetWord="incident"
          check={check}
          problems={problems}
          onCheck={setCheck}
          returnTo={returnTo}
        />
      ) : null}
    </ConfirmAction>
  )
}
