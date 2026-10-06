import 'server-only'

import { connection } from 'next/server'
import { isMemberRole, type MemberRole } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { hashInviteToken, isInviteToken } from '../lib/invite-token'
import { asAnswer } from '../lib/results'
import { type GrantableRole, isGrantableRole } from '../lib/roles'

/**
 * The Members page (MAIL-SPEC §10 Settings): the members and the address each
 * signs in with (`account_members`, migration 46), and the invites still
 * waiting — readable by owners and admins only (RLS on `mail.invites`).
 * Never logged: these are people's addresses (N13).
 */

export type Member = {
  userId: string
  email: string | null
  name: string | null
  role: MemberRole
  joinedAt: string
}

export type PendingInvite = {
  id: string
  email: string
  role: GrantableRole
  createdAt: string
  expiresAt: string
}

export async function getMembers(accountId: string): Promise<Member[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('account_members', { p_account_id: accountId })
  const answer = asAnswer(data)
  if (error || answer?.ok !== true || !Array.isArray(answer.members)) return null
  return answer.members.flatMap((row: unknown) => {
    const r = row as Record<string, unknown>
    if (typeof r.userId !== 'string' || !isMemberRole(r.role)) return []
    return [
      {
        userId: r.userId,
        email: typeof r.email === 'string' ? r.email : null,
        name: typeof r.name === 'string' ? r.name : null,
        role: r.role,
        joinedAt: String(r.joinedAt ?? ''),
      },
    ]
  })
}

export type InvitePreview =
  | { ok: true; accountId: string; accountName: string; role: GrantableRole; expiresAt: string }
  | { ok: false; code: string }

/**
 * What an invite is for, asked by its token's hash (`invite_preview`): only
 * the person it was sent to, signed in with that address, learns the
 * account's name. The token is never logged or stored.
 */
export async function previewInvite(token: string): Promise<InvitePreview> {
  if (!isInviteToken(token)) return { ok: false, code: 'not_found' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('invite_preview', {
    p_token_hash: hashInviteToken(token),
  })
  if (error) throw new Error(`invite_preview failed: ${error.code ?? 'unknown'}`)
  const answer = asAnswer(data)
  if (
    answer?.ok === true &&
    typeof answer.accountId === 'string' &&
    typeof answer.accountName === 'string' &&
    isGrantableRole(answer.role)
  ) {
    return {
      ok: true,
      accountId: answer.accountId,
      accountName: answer.accountName,
      role: answer.role,
      expiresAt: String(answer.expiresAt ?? ''),
    }
  }
  return { ok: false, code: answer?.code ?? 'not_found' }
}

export async function getPendingInvites(accountId: string): Promise<PendingInvite[] | null> {
  await connection()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('invites')
    .select('id, email, role, created_at, expires_at')
    .eq('account_id', accountId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
  if (error) return null
  return (data ?? []).flatMap((row) =>
    isGrantableRole(row.role)
      ? [
          {
            id: row.id,
            email: row.email,
            role: row.role,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          },
        ]
      : [],
  )
}
