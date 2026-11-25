import { ListChecks, Robot, ShoppingCart } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { type CartAddSearch, CartAddView } from '@/features/cart/components/cart-add-view'
import { CartSkeleton } from '@/features/cart/components/cart-contents'
import { NOT_INDEXED, pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Add to your cart',
  path: '/cart/add',
  robots: NOT_INDEXED,
})

/** A link that fills a cart (feature 8), often from an AI assistant. Routing only. */
export default function CartAddPage({ searchParams }: { searchParams: CartAddSearch }) {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          title="Add to your cart"
          intro="These are the names you were sent, with what each costs now and what it renews at. Nothing is in your cart until you add it."
          icons={[ShoppingCart, ListChecks, Robot]}
        />
        <Container className="py-12 sm:py-16">
          <Suspense fallback={<CartSkeleton />}>
            <CartAddView searchParams={searchParams} />
          </Suspense>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
