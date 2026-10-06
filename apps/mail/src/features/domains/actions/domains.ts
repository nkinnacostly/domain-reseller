'use server'

import { revalidatePath } from 'next/cache'
import { accountAction } from '@/lib/safe-action'
import { normaliseDomain } from '../lib/names'
import { asDomainAnswer, domainMessage } from '../lib/results'
import { settleDomainNow } from '../queries/settle'
import { addDomainSchema, domainActionSchema } from '../schemas'

/**
 * The domains page's changes (MAIL-SPEC §5, migration 47). SQL decides each
 * as the person (role, ownership, the plan's count, emails waiting) and logs
 * it; the SES work then runs at once (`settleDomainNow`), and whatever
 * cannot be done now the five-minute job finishes. Owners, admins and
 * developers change domains; any member may check one.
 */

type Failure = { error: string; code?: string }

const DOMAINS_PAGE = '/dashboard/domains'
const MANAGERS = ['owner', 'admin', 'developer'] as const

function refused(data: unknown): Failure | null {
  const answer = asDomainAnswer(data)
  if (answer?.ok === true) return null
  return { error: domainMessage(answer), ...(answer?.code ? { code: answer.code } : {}) }
}

export const addDomain = accountAction(addDomainSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true; domainId: string }> => {
    const name = normaliseDomain(parsedInput.name)
    if (!name) return { error: domainMessage({ code: 'validation' }), code: 'validation' }
    const { data, error } = await ctx.supabase.rpc('add_domain', {
      p_account_id: ctx.account.id,
      p_name: name,
    })
    if (error) throw new Error(`add_domain failed: ${error.code ?? 'unknown'}`)
    const answer = asDomainAnswer(data)
    if (answer?.code === 'already_added' && typeof answer.domainId === 'string') {
      return { ok: true, domainId: answer.domainId }
    }
    const failure = refused(data)
    if (failure) return failure
    const domainId = String(answer?.domainId ?? '')
    await settleDomainNow({ accountId: ctx.account.id, domainId, provision: true })
    revalidatePath(DOMAINS_PAGE, 'layout')
    return { ok: true, domainId }
  },
)

/** "Check now" (§5): GetEmailIdentity, recorded; a domain checked seconds ago is left be. */
export const checkDomain = accountAction(domainActionSchema).action(
  async ({ parsedInput, ctx }): Promise<{ ok: true; outcome: string }> => {
    const outcome = await settleDomainNow({
      accountId: ctx.account.id,
      domainId: parsedInput.domainId,
      provision: true,
    })
    revalidatePath(DOMAINS_PAGE, 'layout')
    return { ok: true, outcome }
  },
)

export const removeDomain = accountAction(domainActionSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const { data, error } = await ctx.supabase.rpc('remove_domain', {
      p_domain_id: parsedInput.domainId,
    })
    if (error) throw new Error(`remove_domain failed: ${error.code ?? 'unknown'}`)
    const failure = refused(data)
    if (failure) return failure
    if (asDomainAnswer(data)?.needsRelease === true) {
      await settleDomainNow({ accountId: ctx.account.id, domainId: parsedInput.domainId })
    }
    revalidatePath(DOMAINS_PAGE, 'layout')
    return { ok: true }
  },
)

/** A failed claim tried again (§5): new DKIM records and another 72 hours. */
export const retryDomain = accountAction(domainActionSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const { data, error } = await ctx.supabase.rpc('retry_domain', {
      p_domain_id: parsedInput.domainId,
    })
    if (error) throw new Error(`retry_domain failed: ${error.code ?? 'unknown'}`)
    const failure = refused(data)
    if (failure) return failure
    await settleDomainNow({
      accountId: ctx.account.id,
      domainId: parsedInput.domainId,
      provision: true,
    })
    revalidatePath(DOMAINS_PAGE, 'layout')
    return { ok: true }
  },
)
