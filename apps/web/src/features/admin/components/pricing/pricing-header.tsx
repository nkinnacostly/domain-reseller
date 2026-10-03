import { PANEL, PanelHeader, PanelPage } from '@/components/layout/panel'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { PRICING_TABS } from '@/features/admin/lib/pricing-copy'
import { cn } from '@/lib/utils'

/**
 * The Pricing pages' shared header (docs/ADMIN-SPEC.md §5.2 B12): where you
 * are, and the two pages as tabs — the current one marked with
 * `aria-current` (S13). There is no Live/Test switch: prices and rates are
 * the same on both sides, so a switch here would change nothing.
 */
export function PricingHeader({ title, description }: { title: string; description: string }) {
  const index = title === 'Pricing'
  return (
    <PanelHeader
      crumbs={[
        { label: 'Admin', href: '/admin' },
        ...(index ? [] : [{ label: 'Pricing', href: '/admin/pricing' }]),
        { label: title },
      ]}
      title={title}
      description={description}
    >
      <RouteTabs label="Pricing pages" tabs={[...PRICING_TABS]} />
    </PanelHeader>
  )
}

/** A Pricing page before the admin is known: the header's shape, then its cards (S11). */
export function PricingPageSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <PanelPage>
      <div aria-hidden="true" className={cn(PANEL, 'h-56 animate-pulse')} />
      <PricingSectionsSkeleton cards={cards} />
    </PanelPage>
  )
}

/** The cards under a header already shown, while they load. */
export function PricingSectionsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <>
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} aria-hidden="true" className={cn(PANEL, 'h-72 animate-pulse')} />
      ))}
    </>
  )
}
