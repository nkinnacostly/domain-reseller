'use client'

import { RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { updatePricingSettings } from '@/features/admin/actions/pricing'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import {
  FIELD_HINT,
  FIELD_UNIT,
  OWNER_ONLY_SETTINGS,
  saveCopy,
} from '@/features/admin/lib/pricing-copy'
import type { PricingSettings, SampleTld } from '@/features/admin/lib/pricing-data'
import {
  changesPrices,
  PRICING_FIELDS,
  type PricingKey,
  priceEffect,
  pricingChanges,
  pricingInputs,
  settingsAfter,
} from '@/features/admin/lib/pricing-rules'

/** The stored settings as the form first shows them. */
function typedFrom(settings: PricingSettings): Record<PricingKey, string> {
  const typed = {} as Record<PricingKey, string>
  for (const field of PRICING_FIELDS) typed[field.key] = String(settings[field.from])
  return typed
}

/**
 * The four pricing settings the dashboard may change (docs/ADMIN-SPEC.md
 * §5.2 B12) — never VAT. Saving is a money action: the dialog shows each
 * value before and after and, when margin or the ICANN fee moves, the
 * example's first-term and renewal prices before and after, priced by the
 * storefront's own functions; then it asks for a reason and the code from
 * the authenticator app. SQL decides who may save; anyone but the owner is
 * refused with their role's words, and nothing changes.
 */
export function SettingsForm({
  settings,
  sample,
  active,
  ownerOnly,
}: {
  settings: PricingSettings
  sample: SampleTld | null
  /** The active rate, priced with its own buffer; null with none. */
  active: { costingRate: number; bufferPct: number } | null
  /** True when this admin is not the owner: the form says so before anyone types a code. */
  ownerOnly: boolean
}) {
  const id = useId()
  const [typed, setTyped] = useState(() => typedFrom(settings))
  const { changes, errors } = pricingChanges(settings, typed)
  const changed = Object.keys(changes).length
  const invalid = Object.keys(errors).length > 0
  const effect = changesPrices(changes)
    ? priceEffect(
        sample?.onSale ? sample : null,
        pricingInputs(active, settings),
        pricingInputs(active, settingsAfter(settings, changes)),
      )
    : null
  const copy = saveCopy({
    changes,
    current: settings,
    effect,
    activeBufferPct: active?.bufferPct ?? null,
  })

  const state = invalid
    ? 'Fix the values marked above to save.'
    : changed === 0
      ? 'Change a value to save it.'
      : `${changed} ${changed === 1 ? 'change' : 'changes'} ready to save.`

  return (
    <form
      onSubmit={(event) => event.preventDefault()}
      noValidate
      aria-label="Change pricing settings"
      className="space-y-5"
    >
      {ownerOnly ? (
        <p className="max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
          {OWNER_ONLY_SETTINGS}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {PRICING_FIELDS.map((field) => {
          const fieldId = `${id}-${field.key}`
          const error = errors[field.key]
          return (
            <Field
              key={field.key}
              id={fieldId}
              label={`${field.label} (${FIELD_UNIT[field.key]})`}
              error={error}
              hint={FIELD_HINT[field.key]}
            >
              <input
                id={fieldId}
                name={field.key}
                value={typed[field.key]}
                onChange={(event) =>
                  setTyped((current) => ({ ...current, [field.key]: event.target.value }))
                }
                inputMode={field.decimals === 0 ? 'numeric' : 'decimal'}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(fieldId, error, FIELD_HINT[field.key])}
                className={inputClass}
              />
            </Field>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ConfirmAction
          trigger="Save changes"
          disabled={invalid || changed === 0}
          title={copy.title}
          rows={copy.rows}
          body={
            copy.body.length > 0
              ? copy.body.map((line) => (
                  <p key={line} className="mt-2 first:mt-0">
                    {line}
                  </p>
                ))
              : undefined
          }
          confirmLabel={copy.confirmLabel}
          cancelLabel={copy.cancelLabel}
          reason="required"
          needsCode
          returnTo="/admin/pricing"
          successMessage={copy.success}
          run={async ({ reason, requestKey, code }) =>
            adminOutcome(
              await updatePricingSettings({
                changes,
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
        <button
          type="button"
          onClick={() => setTyped(typedFrom(settings))}
          disabled={changed === 0 && !invalid}
          className={QUIET_BUTTON}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Undo changes
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {state}
        </p>
      </div>
    </form>
  )
}
