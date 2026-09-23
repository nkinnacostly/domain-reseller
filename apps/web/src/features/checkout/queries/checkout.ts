import 'server-only'

import { getCartView } from '@/features/cart/queries/cart'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { checkoutOpenTo } from '../lib/access'
import type { RegistrantForm } from '../lib/contact'

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

  const [cart, { data: contact }, { data: profile }] = await Promise.all([
    getCartView(),
    supabase
      .from('contact_profiles')
      .select(
        'id, first_name, last_name, company, email, phone, phone_country_code, address_line1, address_line2, city, state, zip_code, country',
      )
      .eq('user_id', user.id)
      .eq('is_default', true)
      .maybeSingle(),
    supabase.from('profiles').select('full_name, phone').eq('id', user.id).single(),
  ])

  const [firstName = '', ...rest] = (profile?.full_name ?? '').trim().split(/\s+/)
  const registrant: RegistrantForm = contact
    ? {
        firstName: contact.first_name,
        lastName: contact.last_name,
        company: contact.company ?? '',
        email: contact.email,
        phoneCountryCode: contact.phone_country_code,
        phone: contact.phone,
        addressLine1: contact.address_line1,
        addressLine2: contact.address_line2 ?? '',
        city: contact.city,
        state: contact.state,
        zipCode: contact.zip_code,
        country: contact.country,
      }
    : {
        firstName,
        lastName: rest.join(' '),
        company: '',
        email: user.email ?? '',
        phoneCountryCode: '234',
        phone: profile?.phone ?? '',
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        zipCode: '',
        country: 'NG',
      }

  const secretKey = env.FLUTTERWAVE_SECRET_KEY
  return {
    cart,
    registrant,
    open: checkoutOpenTo(user.email, env.CHECKOUT_ALLOWLIST),
    paymentsConfigured: Boolean(secretKey && env.FLUTTERWAVE_WEBHOOK_HASH),
    testMode: !secretKey || secretKey.includes('_TEST-'),
  }
}
