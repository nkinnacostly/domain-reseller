'use server'

import type { Json } from '@dr/db/types'
import { GatewayError } from '@dr/shared/errors'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { registrantFormSchema, toContact } from '@/features/checkout/lib/contact'
import {
  CONTACT_ROLES,
  readRoles,
  roleChoiceSchema,
  type StoredContact,
  sameContact,
  sameRoles,
  withRole,
} from '@/features/contacts/lib/roles'
import { resolveRoleChoice } from '@/features/contacts/queries/profiles'
import { BUSINESS } from '@/lib/business'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { withinLimit } from '@/lib/rate-limit'
import { authAction, elevatedAction } from '@/lib/safe-action'
import type { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  isMaterialChange,
  privacyOffered,
  sameRegistrant,
  settingsAvailability,
  transferCodeUnavailable,
} from '../lib/settings'

/**
 * Registry-side settings (FR-DS1, FR-DS3, FR-DS4, FR-DS5). Ownership is
 * checked as the user (RLS); the request is then written with the secret key
 * as a pending value and queued for the gateway, which applies it and
 * records what the registry holds (migration 26). The domain's own columns
 * change only when the registry confirms. Every request leaves a
 * domain_events row — never with contact details or a code in it (N13).
 */

type Supabase = Awaited<ReturnType<typeof createClient>>
type Ctx = { supabase: Supabase; user: { id: string } }

const COLUMNS =
  'id, domain_name, tld, source, test_mode, local_status, transfer_lock, privacy_enabled, registrant, contacts, pending_transfer_lock, pending_privacy, pending_registrant, pending_contacts'

async function ownedDomain(supabase: Supabase, domainId: string) {
  const { data } = await supabase.from('domains').select(COLUMNS).eq('id', domainId).maybeSingle()
  return data
}
type Domain = NonNullable<Awaited<ReturnType<typeof ownedDomain>>>

export type SettingResult = { error: string; field?: 'acceptTransferLock' } | { ok: true }

const NOT_YOURS = { error: 'That domain is not on your account.' }
const FAILED = 'That change could not be saved. Please try again.'

/** Why this domain's settings cannot be changed, or null when they can. */
function refusal(domain: Domain): string | null {
  const availability = settingsAvailability({
    status: domain.local_status as Parameters<typeof settingsAvailability>[0]['status'],
    source: domain.source as Parameters<typeof settingsAvailability>[0]['source'],
    testMode: domain.test_mode,
  })
  return availability.editable ? null : availability.note.body
}

type Setting = 'transfer_lock' | 'privacy' | 'contacts'
const KIND = {
  transfer_lock: 'set_transfer_lock',
  privacy: 'set_privacy',
  contacts: 'update_contacts',
} as const

/**
 * Sends the change to the queue. Idempotent: one open job per domain and
 * setting (migration 26), so asking again re-queues a change whose earlier
 * queueing failed and otherwise does nothing.
 */
async function queue(domain: Domain, setting: Setting): Promise<SettingResult> {
  const { error } = await createServiceClient().rpc('enqueue_domain_change', {
    p_domain_id: domain.id,
    p_kind: KIND[setting],
  })
  revalidatePath(`/app/domains/${domain.domain_name}`, 'layout')
  if (error) {
    logger.error({ err: error, domainId: domain.id, setting }, 'settings change not queued')
    return { error: FAILED }
  }
  return { ok: true }
}

/** Records the request (the pending value and who asked), then queues it. */
async function request(
  ctx: Ctx,
  domain: Domain,
  setting: Setting,
  pending:
    | { pending_transfer_lock: boolean }
    | { pending_privacy: boolean }
    | { pending_registrant: Json }
    | { pending_contacts: Json },
  payload: Json,
): Promise<SettingResult> {
  const service = createServiceClient()
  const { error } = await service.from('domains').update(pending).eq('id', domain.id)
  if (error) {
    logger.error({ err: error, domainId: domain.id, setting }, 'settings request not saved')
    return { error: FAILED }
  }
  await service.from('domain_events').insert({
    domain_id: domain.id,
    event_type: `${setting}_requested`,
    actor_type: 'user',
    actor_id: ctx.user.id,
    payload,
  })
  return queue(domain, setting)
}

async function setLock(ctx: Ctx, domainId: string, locked: boolean): Promise<SettingResult> {
  const domain = await ownedDomain(ctx.supabase, domainId)
  if (!domain) return NOT_YOURS
  const refused = refusal(domain)
  if (refused) return { error: refused }

  if (domain.pending_transfer_lock === locked) return queue(domain, 'transfer_lock')
  // Nothing on its way and the registry already holds it: nothing to do. A
  // change on its way the other way is overtaken, not cancelled — the newer
  // request is sent once the registry has answered the first (migration 26).
  if (domain.pending_transfer_lock === null && domain.transfer_lock === locked) return { ok: true }
  return request(ctx, domain, 'transfer_lock', { pending_transfer_lock: locked }, { to: locked })
}

/** FR-DS4: the lock goes on with a signed-in session. */
export const lockTransfers = authAction
  .inputSchema(z.object({ domainId: z.uuid() }))
  .action(({ parsedInput, ctx }) => setLock(ctx, parsedInput.domainId, true))

/**
 * FR-DS4, SEC-2: turning the lock off is what a thief needs first, so it
 * takes a second factor from the last 15 minutes and no post-reset hold.
 */
export const unlockTransfers = elevatedAction
  .inputSchema(z.object({ domainId: z.uuid() }))
  .action(({ parsedInput, ctx }) => setLock(ctx, parsedInput.domainId, false))

/** FR-DS3: contact privacy, where the extension offers it (as checkout does). */
export const setPrivacy = authAction
  .inputSchema(z.object({ domainId: z.uuid(), enabled: z.boolean() }))
  .action(async ({ parsedInput, ctx }): Promise<SettingResult> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return NOT_YOURS
    const refused = refusal(domain)
    if (refused) return { error: refused }
    if (!privacyOffered(domain.tld)) {
      return { error: `Contact privacy is not offered for .${domain.tld} domains.` }
    }

    const enabled = parsedInput.enabled
    if (domain.pending_privacy === enabled) return queue(domain, 'privacy')
    if (domain.pending_privacy === null && domain.privacy_enabled === enabled) return { ok: true }
    return request(ctx, domain, 'privacy', { pending_privacy: enabled }, { to: enabled })
  })

/**
 * FR-DS1, FR-DS2, SEC-2: a new registrant. For a generic extension a new
 * name, organisation or email is a change of registrant under ICANN's
 * Transfer Policy, which can lock transfers for 60 days: it is saved only
 * with the customer's explicit acceptance, never silently.
 */
export const changeRegistrant = elevatedAction
  .inputSchema(
    z.object({
      domainId: z.uuid(),
      registrant: registrantFormSchema,
      acceptTransferLock: z.boolean(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<SettingResult> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return NOT_YOURS
    const refused = refusal(domain)
    if (refused) return { error: refused }

    let contact: ReturnType<typeof toContact>
    try {
      contact = toContact(parsedInput.registrant)
    } catch {
      return { error: 'Check the phone number: it should be 4 to 15 digits after the code.' }
    }

    const current = domain.registrant as Record<string, string> | null
    const pending = domain.pending_registrant as Record<string, string> | null
    if (sameRegistrant(pending ?? current, contact)) {
      return pending ? queue(domain, 'contacts') : { ok: true }
    }

    const material = privacyOffered(domain.tld) && isMaterialChange(current, contact)
    if (material && !parsedInput.acceptTransferLock) {
      return {
        error:
          'A new name, organisation or email can lock transfers for 60 days. Tick the box to go ahead.',
        field: 'acceptTransferLock',
      }
    }
    return request(ctx, domain, 'contacts', { pending_registrant: contact as Json }, { material })
  })

/**
 * FR-DS1, SEC-2: the administrative, technical or billing contact — the
 * registrant, a saved profile (read again under RLS), or new details. Sent
 * as the whole set of roles (`pending_contacts`, migration 29), merged over
 * any change already on its way; a role left out follows the registrant, so
 * `{}` hands all three back. Unlike the registrant (FR-DS2), no role change
 * starts ICANN's 60-day transfer lock, so none is warned about.
 */
export const changeContactRole = elevatedAction
  .inputSchema(
    z.object({ domainId: z.uuid(), role: z.enum(CONTACT_ROLES), choice: roleChoiceSchema }),
  )
  .action(async ({ parsedInput, ctx }): Promise<SettingResult> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return NOT_YOURS
    const refused = refusal(domain)
    if (refused) return { error: refused }

    const resolved = await resolveRoleChoice(ctx.supabase, parsedInput.choice)
    if (!resolved.ok) return { error: resolved.error }

    const current = readRoles(domain.contacts)
    const pending = domain.pending_contacts === null ? null : readRoles(domain.pending_contacts)
    // The registrant the role would follow: the one on its way, if any. Its
    // own details in a role are the registrant's role (migration 29).
    const registrant = (domain.pending_registrant ?? domain.registrant) as StoredContact | null
    const holder =
      resolved.contact && !(registrant && sameContact(registrant, resolved.contact))
        ? resolved.contact
        : null
    const next = withRole(pending ?? current, parsedInput.role, holder)

    // As with the lock: asked again re-queues; the registry's own is a no-op.
    if (pending && sameRoles(pending, next)) return queue(domain, 'contacts')
    if (!pending && sameRoles(current, next)) return { ok: true }
    return request(
      ctx,
      domain,
      'contacts',
      { pending_contacts: next as Json },
      { roles: [parsedInput.role] },
    )
  })

/** Per account: a person needs a code a few times at most; a script needs many. */
const TRANSFER_CODE_LIMIT = { max: 5, windowSeconds: 3600 }

const CODE_ERROR: Record<string, string> = {
  DOMAIN_NOT_FOUND: `The registry does not list this domain in our account. Email ${BUSINESS.email} and we will sort it out.`,
  RATE_LIMITED: 'This domain’s code has been asked for several times recently. Try again later.',
  AUTH_CODE_UNAVAILABLE: `The registry gave no transfer code for this domain. Email ${BUSINESS.email} and we will get it for you within five days.`,
  WRONG_REGISTRY:
    'We cannot reach the registry that holds this domain just now. Please try again later.',
}
const CODE_FALLBACK = `We could not reach the registry just now. Please try again in a few minutes — if it keeps failing, email ${BUSINESS.email} and we will send the code within five days.`

/**
 * FR-DS5, FR-T5, SEC-2: the transfer code, read from the registry for this
 * request and shown once — never stored or logged (SEC-12, N13). Needs a
 * fresh second factor. Never conditioned on billing (N14, FR-T6). Each reveal
 * is recorded in the activity log without the code; if that record cannot
 * be written, the code is not shown.
 */
export const revealTransferCode = elevatedAction
  .inputSchema(z.object({ domainId: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | { ok: true; code: string }> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return NOT_YOURS
    const unavailable = transferCodeUnavailable({
      status: domain.local_status as Parameters<typeof transferCodeUnavailable>[0]['status'],
      source: domain.source as Parameters<typeof transferCodeUnavailable>[0]['source'],
      testMode: domain.test_mode,
    })
    if (unavailable) return { error: unavailable }

    if (!(await withinLimit(`transfer-code:${ctx.user.id}`, TRANSFER_CODE_LIMIT))) {
      return {
        error: 'You have asked for transfer codes several times in the last hour. Try again later.',
      }
    }

    let code: string
    try {
      const side = domain.test_mode ? 'sandbox' : 'live'
      const answer = await callGateway<{ authCode: string }>({
        path: `domains/${encodeURIComponent(domain.domain_name)}/auth-code?side=${side}`,
      })
      code = answer.authCode
    } catch (error) {
      const reason = error instanceof GatewayError ? error.code : 'GATEWAY_UNAVAILABLE'
      logger.warn({ domainId: domain.id, code: reason }, 'transfer code not read')
      return { error: CODE_ERROR[reason] ?? CODE_FALLBACK }
    }

    const { error } = await createServiceClient()
      .from('domain_events')
      .insert({
        domain_id: domain.id,
        event_type: 'auth_code_revealed',
        actor_type: 'user',
        actor_id: ctx.user.id,
        payload: { sandbox: domain.test_mode },
      })
    if (error) {
      logger.error({ err: error, domainId: domain.id }, 'transfer code reveal not recorded')
      return { error: 'We could not record this request, so the code was not shown. Try again.' }
    }
    return { ok: true, code }
  })
