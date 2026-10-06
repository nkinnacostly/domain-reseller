import { AppError } from '@dr/shared/errors'
import type { User } from '@supabase/supabase-js'
import { headers } from 'next/headers'
import {
  createSafeActionClient,
  type SafeActionClient,
  type ValidationErrors,
} from 'next-safe-action'
import type { z } from 'zod'
import { logger } from '@/lib/logger'
import { createClient, type MailSessionClient } from '@/lib/supabase/server'

/**
 * Server Action clients for Mail, as in the shop (CLAUDE.md §8):
 *
 * `actionClient`  — public actions
 * `authAction`    — a signed-in person (Supabase Auth is shared, M5)
 * `accountAction` — a member of the `mail.accounts` row the input names, in
 *                   one of the roles the action allows. Membership is read
 *                   with the person's own session, so RLS answers the
 *                   question; SQL functions check it again on every write.
 */

export const SERVER_CRASH_WORDS = 'Something went wrong on our end. Please try again.'

function handleServerError(error: Error) {
  if (error instanceof AppError) return error.message
  logger.error({ err: error.message }, 'unhandled server action error')
  return SERVER_CRASH_WORDS
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const actionClient = createSafeActionClient({ handleServerError }).use(async ({ next }) => {
  const sent = (await headers()).get('x-request-id')
  return next({ ctx: { requestId: sent && UUID.test(sent) ? sent : crypto.randomUUID() } })
})

export const authAction = actionClient.use(async ({ next }) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')
  return next({ ctx: { user, supabase } })
})

export const MEMBER_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const isMemberRole = (value: unknown): value is MemberRole =>
  typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value)

export const NOT_A_MEMBER = 'That account was not found, or you are not one of its members.'
export const ROLE_TOO_LOW = 'Your role in this account cannot do that. Ask its owner or an admin.'

type SignedIn = { requestId: string; user: User; supabase: MailSessionClient }

/** What an account action's body receives: the person, their session client, and their role. */
export type AccountContext = SignedIn & { account: { id: string; role: MemberRole } }

/**
 * The client an account action is built on, typed for its schema. (Written
 * out, as in the shop's adminAction: `useValidated` cannot be typed over a
 * generic schema.)
 */
export type AccountActionClient<S extends z.ZodType> = SafeActionClient<
  string,
  undefined,
  undefined,
  undefined,
  true,
  AccountContext,
  undefined,
  S,
  undefined,
  readonly [],
  ValidationErrors<S>,
  false,
  true,
  SignedIn
>

/**
 * An action on one Mail account. The input is validated first and must
 * carry `accountId`; the caller's role there comes from `mail.members`, and
 * must be one of `roles`.
 *
 * ```ts
 * export const renameAccount = accountAction(schema, ['owner', 'admin'])
 *   .action(async ({ parsedInput, ctx }) => ctx.account.role)
 * ```
 */
export function accountAction<S extends z.ZodType<{ accountId: string }>>(
  schema: S,
  roles: readonly MemberRole[] = MEMBER_ROLES,
): AccountActionClient<S> {
  return authAction
    .inputSchema(schema as z.ZodType)
    .useValidated(async ({ next, ctx, parsedInput }) => {
      const accountId = (parsedInput as { accountId: string }).accountId
      if (!UUID.test(accountId)) throw new AppError('NOT_FOUND', NOT_A_MEMBER)
      const { data, error } = await ctx.supabase
        .from('members')
        .select('role')
        .eq('account_id', accountId)
        .eq('user_id', ctx.user.id)
        .maybeSingle()
      if (error) throw new Error(`membership could not be read: ${error.code ?? 'unknown'}`)
      const role: unknown = data?.role
      if (!isMemberRole(role)) throw new AppError('NOT_FOUND', NOT_A_MEMBER)
      if (!roles.includes(role)) throw new AppError('FORBIDDEN', ROLE_TOO_LOW)
      return next({ ctx: { account: { id: accountId, role } } })
    }) as unknown as AccountActionClient<S>
}
