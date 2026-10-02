'use client'

import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { FormMessage, inputClass, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { addSslToCart } from '@/features/cart/actions/ssl'
import { announceCartCount } from '@/features/cart/lib/count'

/** FR-SSL-6: the name a certificate is for, into the cart at our price. */
export function AddCertificateForm({
  productCode,
  productName,
  label,
  placeholder,
}: {
  productCode: string
  productName: string
  label: string
  placeholder: string
}) {
  const id = useId()
  const add = useAction(addSslToCart, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) announceCartCount(data.count)
    },
  })
  const data = add.result.data
  const error = (data && 'error' in data ? data.error : null) ?? add.result.serverError ?? null
  const added = data && 'name' in data ? data.name : null

  return (
    <form
      aria-label={`Add ${productName} to cart`}
      noValidate
      className="space-y-3"
      onSubmit={onSubmitWith((form) => {
        add.execute({ productCode, name: String(form.get('name') ?? '') })
      })}
    >
      <div>
        <label htmlFor={`${id}-name`} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <input
          id={`${id}-name`}
          name="name"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          maxLength={253}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`${inputClass} mt-1.5`}
        />
      </div>
      <SubmitButton pending={add.isPending} pendingLabel="Adding…">
        Add to cart
      </SubmitButton>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {added ? (
        <FormMessage tone="success">
          The certificate for <span className="font-mono break-all">{added}</span> is in your cart.{' '}
          <Link
            href="/cart"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            Go to your cart
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </FormMessage>
      ) : null}
    </form>
  )
}
