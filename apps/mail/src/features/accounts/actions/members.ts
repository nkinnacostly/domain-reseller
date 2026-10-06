'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { env } from '@/lib/env'
import { accountAction, authAction } from '@/lib/safe-action'
import { hashInviteToken, inviteLink, isInviteToken, newInviteToken } from '../lib/invite-token'
import { asAnswer, resultMessage } from '../lib/results'
import {
  acceptInviteSchema,
  accountIdSchema,
  changeRoleSchema,
  createInviteSchema,
  memberSchema,
  revokeInviteSchema,
  transferSchema,
} from '../schemas'
import { forgetAccount, rememberAccount } from './remember'

/**
 * Members, roles and invitations (MAIL-SPEC §9, §10; migration 46). The
 * roles each action allows mirror SQL's, which decides again on every call:
 * the owner manages admins, admins manage developers and viewers.
 */

type Failure = { error: string; code?: string }
type Done = { ok: true }

const MEMBERS_PAGE = '/dashboard/settings/members'

function failed(data: unknown): Failure | null {
  const answer = asAnswer(data)
  if (answer?.ok === true) return null
  return { error: resultMessage(answer), ...(answer?.code ? { code: answer.code } : {}) }
}

/**
 * An invitation: a fresh token, of which SQL keeps only the hash. We do not
 * email invites yet — the link is answered once, for the inviter to copy and
 * send, and never logged (N13).
 */
export const createInvite = accountAction(createInviteSchema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | { link: string; expiresAt: string }> => {
    const { token, hash } = newInviteToken()
    const { data, error } = await ctx.supabase.rpc('create_invite', {
      p_account_id: ctx.account.id,
      p_email: parsedInput.email,
      p_role: parsedInput.role,
      p_token_hash: hash,
    })
    if (error) throw new Error(`create_invite failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    revalidatePath(MEMBERS_PAGE)
    return {
      link: inviteLink(env.NEXT_PUBLIC_MAIL_URL, token),
      expiresAt: String(asAnswer(data)?.expiresAt ?? ''),
    }
  },
)

export const revokeInvite = accountAction(revokeInviteSchema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('revoke_invite', {
      p_invite_id: parsedInput.inviteId,
    })
    if (error) throw new Error(`revoke_invite failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    revalidatePath(MEMBERS_PAGE)
    return { ok: true }
  },
)

/**
 * Joins the account the invite names, as the address it was sent to. The page
 * then loads the dashboard afresh, on the account just joined.
 */
export const acceptInvite = authAction
  .inputSchema(acceptInviteSchema)
  .action(async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    if (!isInviteToken(parsedInput.token)) return { error: resultMessage({ code: 'not_found' }) }
    const { data, error } = await ctx.supabase.rpc('accept_invite', {
      p_token_hash: hashInviteToken(parsedInput.token),
    })
    if (error) throw new Error(`accept_invite failed: ${error.code ?? 'unknown'}`)
    const answer = asAnswer(data)
    if (answer?.ok !== true || typeof answer.accountId !== 'string') {
      return failed(data) ?? { error: resultMessage(null) }
    }
    await rememberAccount(answer.accountId)
    revalidatePath('/dashboard', 'layout')
    return { ok: true }
  })

export const changeMemberRole = accountAction(changeRoleSchema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('change_member_role', {
      p_account_id: ctx.account.id,
      p_user_id: parsedInput.userId,
      p_role: parsedInput.role,
    })
    if (error) throw new Error(`change_member_role failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    revalidatePath(MEMBERS_PAGE)
    return { ok: true }
  },
)

export const removeMember = accountAction(memberSchema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('remove_member', {
      p_account_id: ctx.account.id,
      p_user_id: parsedInput.userId,
    })
    if (error) throw new Error(`remove_member failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    revalidatePath(MEMBERS_PAGE)
    return { ok: true }
  },
)

/** Leaves; the page then loads the dashboard afresh, on another account or onboarding. */
export const leaveAccount = accountAction(z.object({ accountId: accountIdSchema })).action(
  async ({ ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('leave_account', {
      p_account_id: ctx.account.id,
    })
    if (error) throw new Error(`leave_account failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    await forgetAccount()
    revalidatePath('/dashboard', 'layout')
    return { ok: true }
  },
)

/** To another member; the account's name, typed, confirms it is not an accident. */
export const transferOwnership = accountAction(transferSchema, ['owner']).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data: account, error: readError } = await ctx.supabase
      .from('accounts')
      .select('name')
      .eq('id', ctx.account.id)
      .maybeSingle()
    if (readError || !account) throw new Error('account could not be read')
    if (account.name.trim() !== parsedInput.confirmName) {
      return { error: 'That is not the account’s name. Type it exactly as shown to confirm.' }
    }
    const { data, error } = await ctx.supabase.rpc('transfer_ownership', {
      p_account_id: ctx.account.id,
      p_user_id: parsedInput.userId,
    })
    if (error) throw new Error(`transfer_ownership failed: ${error.code ?? 'unknown'}`)
    const refused = failed(data)
    if (refused) return refused
    revalidatePath('/dashboard', 'layout')
    return { ok: true }
  },
)
