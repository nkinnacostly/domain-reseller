import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { CartContents, CartSkeleton } from '@/features/cart/components/cart-contents'

export const metadata: Metadata = { title: 'Your cart', robots: { index: false } }

/**
 * The cart (PRD E3). Public, not under /app: anyone can fill a cart, and it
 * moves to their account when they sign in (FR-C1). Checkout needs sign-in.
 */
export default function CartPage() {
  return (
    <>
      <SiteHeader className="border-border/60 border-b" />
      <main id="main">
        <Container className="py-10 sm:py-14">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Your cart</h1>
          <div className="mt-8">
            <Suspense fallback={<CartSkeleton />}>
              <CartContents />
            </Suspense>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
