'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { env } from '@/lib/env'
import { authAction } from '@/lib/safe-action'
import { authMessage } from '../lib/messages'
import { safeNext } from '../lib/redirect'
import {
  describeHold,
  hasFreshSecondFactor,
  resetHoldUntil,
  startedWithStrongSignIn,
} from '../lib/security'
import { queueAccountNotice } from '../queries/notices'
import { totpCodeSchema } from '../schemas'

/**
 * Two-factor authentication (PRD FR-A2, FR-A3).
 *
 * Turning it on or off is itself a security change, so it follows the same
 * rules as the operations it protects: a session started with the password,
 * and no post-reset hold.
 */

type Supabase = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>

async function securityChangeBlocked(supabase: Supabase, userId: string): Promise<string | null> {
  const [{ data: aal }, { data: profile }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.from('profiles').select('password_reset_at').eq('id', userId).single(),
  ])

  if (!startedWithStrongSignIn(aal?.currentAuthenticationMethods ?? [])) {
    return 'Sign in with your password or Google to change two-factor settings. Sessions started from an email link cannot change security settings.'
  }
  const hold = resetHoldUntil(profile?.password_reset_at ?? null, new Date())
  return hold ? describeHold(hold) : null
}

export const startTotpEnrollment = authAction.action(
  async ({
    ctx,
  }): Promise<{ error: string } | { factorId: string; qrCode: string; secret: string }> => {
    const blocked = await securityChangeBlocked(ctx.supabase, ctx.user.id)
    if (blocked) return { error: blocked }

    const { data: factors } = await ctx.supabase.auth.mfa.listFactors()
    if (factors?.totp.some((factor) => factor.status === 'verified')) {
      return { error: 'Two-factor authentication is already on for this account.' }
    }
    // A set-up abandoned half way leaves an unverified factor; clear it so a
    // fresh one can take the name.
    for (const factor of factors?.all ?? []) {
      if (factor.status === 'unverified')
        await ctx.supabase.auth.mfa.unenroll({ factorId: factor.id })
    }

    const { data, error } = await ctx.supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
      issuer: env.NEXT_PUBLIC_APP_NAME,
    })
    if (error || !data) return { error: authMessage(error?.code) }
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
  },
)

export const confirmTotpEnrollment = authAction
  .inputSchema(z.object({ factorId: z.string().min(1), code: totpCodeSchema }))
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | { ok: true }> => {
    const { error } = await ctx.supabase.auth.mfa.challengeAndVerify({
      factorId: parsedInput.factorId,
      code: parsedInput.code,
    })
    if (error) return { error: authMessage(error.code) }
    await queueAccountNotice(ctx.user.id, 'two_factor_on')
    revalidatePath('/app/settings')
    return { ok: true }
  })

export const disableTwoFactor = authAction
  .inputSchema(z.object({ factorId: z.string().min(1) }))
  .action(
    async ({ parsedInput, ctx }): Promise<{ error: string } | { verify: true } | { ok: true }> => {
      const { data: aal } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      // FR-A3 — a code from the last 15 minutes, not just a verified session.
      if (!hasFreshSecondFactor(aal?.currentAuthenticationMethods ?? [], new Date())) {
        return { verify: true }
      }

      const blocked = await securityChangeBlocked(ctx.supabase, ctx.user.id)
      if (blocked) return { error: blocked }

      const { error } = await ctx.supabase.auth.mfa.unenroll({ factorId: parsedInput.factorId })
      if (error) return { error: authMessage(error.code) }
      await queueAccountNotice(ctx.user.id, 'two_factor_off')
      revalidatePath('/app/settings')
      return { ok: true }
    },
  )

/** The second step of sign-in, and the step-up before sensitive changes. */
export const verifySecondFactor = authAction
  .inputSchema(z.object({ code: totpCodeSchema, next: z.string().optional() }))
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | undefined> => {
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_APP_URL)
    const { data: factors } = await ctx.supabase.auth.mfa.listFactors()
    const factor = factors?.totp.find((candidate) => candidate.status === 'verified')
    if (!factor) redirect(next)

    const { error } = await ctx.supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: parsedInput.code,
    })
    if (error) return { error: authMessage(error.code) }
    redirect(next)
  })
