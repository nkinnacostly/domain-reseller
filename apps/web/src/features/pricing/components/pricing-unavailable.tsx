/**
 * Shown when no exchange rate can be determined.
 *
 * We withhold prices rather than guess. On a storefront that sells honest
 * pricing, a wrong number is worse than no number.
 */
export function PricingUnavailable() {
  return (
    <div
      role="status"
      className="rounded-2xl border border-border border-dashed p-8 text-center sm:p-12"
    >
      <p className="font-semibold text-foreground">Prices are briefly unavailable</p>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
        We would rather show you nothing than show you the wrong figure. Try again in a few minutes
        — or contact us and we will quote you directly.
      </p>
    </div>
  )
}
