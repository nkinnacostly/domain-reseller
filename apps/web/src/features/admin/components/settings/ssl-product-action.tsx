'use client'

import { setSslSellable } from '@/features/admin/actions/ssl-products'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { SSL_COPY, sslOffCopy, sslOnCopy } from '@/features/admin/lib/settings-copy'

/**
 * On sale or off, for one SSL product (docs/ADMIN-SPEC.md §5.2 B13): the
 * owner's, money tier — a reason and the authenticator code. A product
 * DomainNameAPI lists no price for is never offered on: SQL would refuse it
 * (`NO_PRICE`), so the page says why instead of showing a button.
 */
export function SslProductAction({
  productCode,
  name,
  isSellable,
  hasPrice,
}: {
  productCode: string
  name: string
  isSellable: boolean
  hasPrice: boolean
}) {
  if (!isSellable && !hasPrice) {
    return <p className="max-w-xs text-sm text-muted-foreground">{SSL_COPY.noPrice}</p>
  }
  const copy = isSellable ? sslOffCopy(name) : sslOnCopy(name)
  return (
    <ConfirmAction
      trigger={
        <>
          {isSellable ? SSL_COPY.offConfirm : SSL_COPY.onConfirm}{' '}
          <span className="sr-only">{name}</span>
        </>
      }
      title={copy.title}
      rows={[{ label: 'Product code', value: productCode }]}
      body={copy.body}
      confirmLabel={isSellable ? SSL_COPY.offConfirm : SSL_COPY.onConfirm}
      destructive={isSellable}
      reason="required"
      needsCode
      returnTo="/admin/settings/ssl-products"
      successMessage={isSellable ? SSL_COPY.offDone : SSL_COPY.onDone}
      run={async ({ reason, requestKey, code }) =>
        adminOutcome(
          await setSslSellable({
            productCode,
            sellable: !isSellable,
            reason: reason ?? '',
            requestKey,
            code: code ?? '',
          }),
        )
      }
    />
  )
}
