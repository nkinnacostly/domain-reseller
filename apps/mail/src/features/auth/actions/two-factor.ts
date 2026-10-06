'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { BRAND_NAME } from '@/components/layout/brand'
import { env } from '@/lib/env'
import { authAction } from '@/lib/safe-action'
import type { MailSessionClient } from '@/lib/supabase/server'
import { SECURITY_PAGE } from '../lib/links'
import { authMessage } from '../lib/messages'
import { safeNext } from '../lib/redirect'
import {
  describeHold,
  hasFreshSecondFactor,
  NEEDS_STRONG_SIGN_IN,
  resetHoldUntil,
  startedWithStrongSignIn,
} from '../lib/security'
import { queueAccountNotice } from '../queries/notices'
import { readResetHold } from '../queries/security'
import { totpCodeSchema } from '../schemas'

/**
 * Two-factor authentication, as the shop's (FR-A2, FR-A3). The authenticator
 * belongs to the sign-in, shared with the shop (MAIL-SPEC M5), so it follows
 * the shop's rules: changed only in a session started with the password or
 * Google, never during the 24-hour hold after a reset, and turned off only
 * with a fresh code.
 */

async function securityChangeBlocked(
  supabase: MailSessionClient,
  userId: string,
): Promise<string | null> {
  const [{ data: aal }, resetAt] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    readResetHold(supabase, userId),
  ])
  if (!startedWithStrongSignIn(aal?.currentAuthenticationMethods ?? [])) return NEEDS_STRONG_SIGN_IN
  const hold = resetHoldUntil(resetAt, new Date())
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
      return { error: 'Two-factor authentication is already on for your sign-in.' }
    }
    // A set-up abandoned half way leaves an unverified factor; clear it.
    for (const factor of factors?.all ?? []) {
      if (factor.status === 'unverified') {
        await ctx.supabase.auth.mfa.unenroll({ factorId: factor.id })
      }
    }

    const { data, error } = await ctx.supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
      issuer: BRAND_NAME,
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
    revalidatePath(SECURITY_PAGE)
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
      revalidatePath(SECURITY_PAGE)
      return { ok: true }
    },
  )

/** The second step of sign-in, and the step-up before turning two-factor off. */
export const verifySecondFactor = authAction
  .inputSchema(z.object({ code: totpCodeSchema, next: z.string().optional() }))
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | undefined> => {
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_MAIL_URL)
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
