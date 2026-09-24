import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { CartContents, CartSkeleton } from '@/features/cart/components/cart-contents'
import { NOT_INDEXED, pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Your cart',
  path: '/cart',
  robots: NOT_INDEXED,
})

/**
 * The cart (PRD E3). Public, not under /app: anyone can fill a cart, and it
 * moves to their account when they sign in (FR-C1). Checkout needs sign-in.
 */
export default function CartPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          title="Your cart"
          intro="Every domain shows what it costs now and what it renews at. VAT is added as its own line."
          icons={['🛒', '🧾', '✅']}
        />
        <Container className="py-12 sm:py-16">
          <Suspense fallback={<CartSkeleton />}>
            <CartContents />
          </Suspense>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
