'use client'

import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { updateLimits } from '@/features/admin/actions/settings'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { LIMITS_COPY, limitsTitle } from '@/features/admin/lib/settings-copy'
import {
  boundsWords,
  changeRows,
  checkLimits,
  LIMIT_FIELDS,
  LIMIT_GROUPS,
  type LimitField,
  type LimitKey,
  type Limits,
  limitInputs,
  refundDirection,
} from '@/features/admin/lib/settings-limits'
import { cn } from '@/lib/utils'

/**
 * The 11 limits as a form (docs/ADMIN-SPEC.md §5.2 B13): grouped Refunds ·
 * Orders · Velocity · Float, each input with its bounds, each value checked
 * as it is typed against the wrapper's own rules. Saving is the owner's and
 * money tier: a dialog shows every change before → after, says what a rise
 * or a fall in a refund limit does, and asks for a reason and the code from
 * the authenticator app.
 */

const UNIT_SUFFIX: Partial<Record<LimitField['unit'], string>> = {
  minutes: 'minutes',
  days: 'days',
  domains: 'domains',
  orders: 'orders',
}

export function LimitsForm({ limits }: { limits: Limits }) {
  const [typed, setTyped] = useState<Record<LimitKey, string>>(() => limitInputs(limits))
  const { errors, changes } = checkLimits(typed, limits)
  const rows = changeRows(limits, changes)
  const invalid = Object.keys(errors).length > 0
  const direction = refundDirection(limits, changes)
  const start = limitInputs(limits)
  const edited = LIMIT_FIELDS.some((field) => typed[field.key] !== start[field.key])

  return (
    <form
      aria-label="Limits"
      className="mt-5 space-y-6"
      onSubmit={(event) => event.preventDefault()}
      noValidate
    >
      {LIMIT_GROUPS.map((group) => (
        <fieldset key={group.id} className="space-y-4" data-group={group.id}>
          <legend className="text-sm font-semibold text-foreground">{group.title}</legend>
          <div className="grid gap-4 md:grid-cols-2">
            {LIMIT_FIELDS.filter((field) => field.group === group.id).map((field) => {
              const id = `limit-${field.key}`
              const error = errors[field.key]
              const hint = `${field.help} ${boundsWords(field)}`
              const money = field.unit === 'kobo' || field.unit === 'cents'
              const suffix = UNIT_SUFFIX[field.unit]
              return (
                <Field key={field.key} id={id} label={field.label} error={error} hint={hint}>
                  <div className="flex items-center gap-2">
                    {money ? (
                      <span aria-hidden="true" className="text-muted-foreground">
                        {field.unit === 'kobo' ? '₦' : '$'}
                      </span>
                    ) : null}
                    <input
                      id={id}
                      name={field.key}
                      value={typed[field.key]}
                      onChange={(event) =>
                        setTyped((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      inputMode={money ? 'decimal' : 'numeric'}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={describedBy(id, error, hint)}
                      className={cn(inputClass, 'max-w-48 tabular-nums')}
                    />
                    {suffix ? (
                      <span className="text-sm text-muted-foreground">{suffix}</span>
                    ) : null}
                  </div>
                </Field>
              )
            })}
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-3 border-border border-t pt-5">
        <ConfirmAction
          trigger={LIMITS_COPY.review}
          disabled={rows.length === 0 || invalid}
          title={limitsTitle(rows.length)}
          rows={rows.map((row) => ({ label: row.label, value: `${row.before} → ${row.after}` }))}
          body={
            direction.raises || direction.lowers ? (
              <>
                {direction.raises ? <p>{LIMITS_COPY.raise}</p> : null}
                {direction.lowers ? (
                  <p className={direction.raises ? 'mt-2' : undefined}>{LIMITS_COPY.lower}</p>
                ) : null}
              </>
            ) : undefined
          }
          confirmLabel={LIMITS_COPY.confirm}
          cancelLabel={LIMITS_COPY.cancel}
          reason="required"
          needsCode
          returnTo="/admin/settings"
          successMessage={LIMITS_COPY.done}
          run={async ({ reason, requestKey, code }) =>
            adminOutcome(
              await updateLimits({
                changes,
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
        {edited ? (
          <button type="button" onClick={() => setTyped(start)} className={QUIET_BUTTON}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Undo changes
          </button>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {invalid
            ? 'Fix the values marked above to save.'
            : rows.length === 0
              ? LIMITS_COPY.noChanges
              : `${rows.length} ${rows.length === 1 ? 'change' : 'changes'} ready to review.`}
        </p>
      </div>
    </form>
  )
}
