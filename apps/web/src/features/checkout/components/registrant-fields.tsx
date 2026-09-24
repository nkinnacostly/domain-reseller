'use client'

import { useMemo, useState } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import type { RegistrantForm } from '../lib/contact'
import { NIGERIAN_STATES, REGISTRANT_COUNTRIES } from '../lib/countries'

/**
 * The registrant's fields (PRD FR-A4), as checkout asks for them and as a
 * domain's Contacts tab edits them (FR-DS1). Uncontrolled: the form reads
 * them with FormData, so autofill and password managers are never undone.
 */
export function RegistrantFields({
  idPrefix,
  namePrefix = '',
  registrant,
  errorFor,
}: {
  idPrefix: string
  /**
   * Prepended to every field's name, so one form can hold several contacts
   * (FR-A4) — read back with `registrantFromForm(form, namePrefix)`.
   */
  namePrefix?: string
  /** What the fields start with; a new registrant starts empty. */
  registrant: Partial<RegistrantForm>
  /** The validation message for one field, if it has one. */
  errorFor: (name: keyof RegistrantForm) => string | undefined
}) {
  const id = idPrefix
  const [country, setCountry] = useState(registrant.country ?? 'NG')
  const countryNames = useMemo(() => new Intl.DisplayNames(['en'], { type: 'region' }), [])

  const field = (name: keyof RegistrantForm) => {
    const error = errorFor(name)
    return {
      id: `${id}-${name}`,
      name: `${namePrefix}${name}`,
      defaultValue: (registrant[name] as string | undefined) ?? '',
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy(`${id}-${name}`, error),
      className: inputClass,
      error,
    }
  }
  const input = (name: keyof RegistrantForm, extra: React.ComponentProps<'input'> = {}) => {
    const { error: _error, ...props } = field(name)
    return <input {...props} {...extra} />
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={`${id}-firstName`} label="First name" error={field('firstName').error}>
        {input('firstName', { autoComplete: 'given-name' })}
      </Field>
      <Field id={`${id}-lastName`} label="Last name" error={field('lastName').error}>
        {input('lastName', { autoComplete: 'family-name' })}
      </Field>
      <div className="sm:col-span-2">
        <Field id={`${id}-company`} label="Company (optional)" error={field('company').error}>
          {input('company', { autoComplete: 'organization' })}
        </Field>
      </div>
      <Field id={`${id}-email`} label="Email" error={field('email').error}>
        {input('email', { type: 'email', autoComplete: 'email', inputMode: 'email' })}
      </Field>
      <div className="grid grid-cols-[6rem_1fr] gap-3">
        <Field id={`${id}-phoneCountryCode`} label="Code" error={field('phoneCountryCode').error}>
          {input('phoneCountryCode', {
            inputMode: 'numeric',
            autoComplete: 'tel-country-code',
          })}
        </Field>
        <Field id={`${id}-phone`} label="Phone" error={field('phone').error}>
          {input('phone', {
            type: 'tel',
            autoComplete: 'tel-national',
            inputMode: 'tel',
            placeholder: '0803 123 4567',
          })}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field id={`${id}-addressLine1`} label="Street address" error={field('addressLine1').error}>
          {input('addressLine1', { autoComplete: 'address-line1' })}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field
          id={`${id}-addressLine2`}
          label="Address line 2 (optional)"
          error={field('addressLine2').error}
        >
          {input('addressLine2', { autoComplete: 'address-line2' })}
        </Field>
      </div>
      <Field id={`${id}-city`} label="City" error={field('city').error}>
        {input('city', { autoComplete: 'address-level2' })}
      </Field>
      <Field id={`${id}-state`} label="State" error={field('state').error}>
        {input('state', {
          autoComplete: 'address-level1',
          list: country === 'NG' ? `${id}-ng-states` : undefined,
        })}
      </Field>
      <datalist id={`${id}-ng-states`}>
        {NIGERIAN_STATES.map((state) => (
          <option key={state} value={state} />
        ))}
      </datalist>
      <Field
        id={`${id}-zipCode`}
        label="Postcode"
        error={field('zipCode').error}
        hint={
          country === 'NG'
            ? 'Nigerian postcodes are 6 digits — 100001 is central Lagos.'
            : undefined
        }
      >
        {input('zipCode', {
          autoComplete: 'postal-code',
          'aria-describedby': describedBy(
            `${id}-zipCode`,
            field('zipCode').error,
            country === 'NG' ? 'hint' : undefined,
          ),
        })}
      </Field>
      <Field id={`${id}-country`} label="Country" error={field('country').error}>
        <select
          id={`${id}-country`}
          name={`${namePrefix}country`}
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          autoComplete="country"
          className={inputClass}
        >
          {REGISTRANT_COUNTRIES.map((code) => (
            <option key={code} value={code}>
              {countryNames.of(code) ?? code}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}
