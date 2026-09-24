import 'server-only'

import { getCartView } from '@/features/cart/queries/cart'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { checkoutOpenTo } from '../lib/access'
import { defaultRegistrant } from './registrant'

/**
 * Everything the checkout page needs: the cart priced now, the registrant to
 * pre-fill (the saved default contact, else what the account knows), and
 * whether payments run on Flutterwave test keys.
 */
export async function getCheckoutView() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const [cart, registrant] = await Promise.all([getCartView(), defaultRegistrant(supabase, user)])

  const secretKey = env.FLUTTERWAVE_SECRET_KEY
  return {
    cart,
    registrant,
    open: checkoutOpenTo(user.email, env.CHECKOUT_ALLOWLIST),
    paymentsConfigured: Boolean(secretKey && env.FLUTTERWAVE_WEBHOOK_HASH),
    testMode: !secretKey || secretKey.includes('_TEST-'),
  }
}
