import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import { LABEL_COLOR_NAME, LABEL_COLORS, LABEL_MAX_LENGTH, type LabelColor } from '../lib/labels'
import { LABEL_SWATCH } from './label-chip'

/**
 * A label's name and colour, as a form holds them (FR-P3). The colour is a
 * set of radios, each with its name beside its swatch — a colour is never
 * the only way to tell them apart (S8) — and each a 44px target (S7).
 * Uncontrolled: the form reads them with FormData.
 */
export function LabelFields({
  idPrefix,
  name = '',
  color = 'blue',
  error,
  disabled = false,
}: {
  idPrefix: string
  name?: string
  color?: LabelColor
  error?: string | undefined
  disabled?: boolean
}) {
  return (
    <div className="space-y-4">
      <Field
        id={`${idPrefix}-name`}
        label="Label name"
        error={error}
        hint={`Up to ${LABEL_MAX_LENGTH} characters — for example a client or a project.`}
      >
        <input
          id={`${idPrefix}-name`}
          name="name"
          defaultValue={name}
          maxLength={LABEL_MAX_LENGTH}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(`${idPrefix}-name`, error, 'hint')}
          className={inputClass}
        />
      </Field>
      <fieldset disabled={disabled}>
        <legend className="text-sm font-medium text-foreground">Colour</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {LABEL_COLORS.map((option) => (
            <label
              key={option}
              className={cn(
                // Relative: the radio is sr-only, and must not escape to widen the page.
                'relative inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-background px-3.5 text-sm text-foreground transition hover:bg-muted active:scale-[0.98]',
                'has-checked:border-ring has-checked:ring-2 has-checked:ring-ring/40',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
                'has-disabled:cursor-not-allowed has-disabled:opacity-60',
              )}
            >
              <input
                type="radio"
                name="color"
                value={option}
                defaultChecked={option === color}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn('size-3.5 rounded-full', LABEL_SWATCH[option])}
              />
              {LABEL_COLOR_NAME[option]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

/** The colour a submitted form chose, or blue if none was. */
export function colorFromForm(form: FormData): LabelColor {
  const value = String(form.get('color') ?? '')
  return (LABEL_COLORS as readonly string[]).includes(value) ? (value as LabelColor) : 'blue'
}
