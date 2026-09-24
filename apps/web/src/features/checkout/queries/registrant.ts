import 'server-only'

import type { Contact } from '@dr/shared'
import { logger } from '@/lib/logger'
import type { createClient } from '@/lib/supabase/server'
import type { RegistrantForm } from '../lib/contact'

/** The signed-in person's client (RLS): everything here is their own row. */
type Client = Awaited<ReturnType<typeof createClient>>

/**
 * The registrant to pre-fill: the saved default contact, else what the
 * account knows. Checkout and the transfer checkout start from the same one.
 */
export async function defaultRegistrant(
  supabase: Client,
  user: { id: string; email?: string | null | undefined },
): Promise<RegistrantForm> {
  const [{ data: contact }, { data: profile }] = await Promise.all([
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

  if (contact) {
    return {
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
  }
  const [firstName = '', ...rest] = (profile?.full_name ?? '').trim().split(/\s+/)
  return {
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
}

/**
 * Keeps the registrant as the account's default contact for next time, as
 * the user (RLS). Returns its id, or null when it could not be saved — which
 * never stops a purchase. PostgREST's `details` can quote the row, so only
 * the code and message are logged (N13).
 */
export async function saveDefaultContact(
  supabase: Client,
  userId: string,
  registrant: Contact,
): Promise<string | null> {
  const row = {
    user_id: userId,
    label: 'Registrant',
    first_name: registrant.firstName,
    last_name: registrant.lastName,
    company: registrant.company ?? null,
    email: registrant.email,
    phone: registrant.phone,
    phone_country_code: registrant.phoneCountryCode,
    address_line1: registrant.addressLine1,
    address_line2: registrant.addressLine2 ?? null,
    city: registrant.city,
    state: registrant.state,
    zip_code: registrant.zipCode,
    country: registrant.country,
    is_default: true,
  }
  const { data: existing } = await supabase
    .from('contact_profiles')
    .select('id')
    .eq('user_id', userId)
    .eq('is_default', true)
    .maybeSingle()
  // A default the person named on the Contacts page keeps its name (FR-A4).
  const { label: _label, ...details } = row
  const saved = existing
    ? await supabase
        .from('contact_profiles')
        .update(details)
        .eq('id', existing.id)
        .select('id')
        .single()
    : await supabase.from('contact_profiles').insert(row).select('id').single()
  if (saved.error) {
    logger.warn(
      { code: saved.error.code, err: saved.error.message },
      'could not save default contact',
    )
    return null
  }
  return saved.data?.id ?? null
}
