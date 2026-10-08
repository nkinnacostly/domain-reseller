'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { actionClient, partialAuthAction } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { humanCheckError, verifyTurnstile } from '@/lib/turnstile'
import { mailUrl } from '../lib/links'
import { authMessage } from '../lib/messages'
import { safeNext } from '../lib/redirect'
import { noteSignIn } from '../queries/notices'
import { emailOnlySchema, signInSchema, signUpSchema } from '../schemas'

/**
 * Signing in and up (MAIL-SPEC §7.1), on the shop's Supabase Auth (M5): one
 * sign-in for both products, so a shop customer signs in here with the same
 * password. Expected failures come back as `{ error }` for the form to show;
 * nothing throws.
 */
type Failure = { error: string }

/**
 * Every action here that sends an email asks Turnstile first, before
 * Supabase, as the shop's do (SEC-9): a form that mails any address on
 * request can be aimed at someone else's inbox. Password sign-in sends none.
 */
async function refuseBots(token: string | undefined): Promise<Failure | null> {
  const check = await verifyTurnstile(token, await headers())
  return check.ok ? null : { error: humanCheckError(check) }
}

export const signIn = actionClient
  .inputSchema(signInSchema)
  .action(async ({ parsedInput }): Promise<Failure | undefined> => {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsedInput.email,
      password: parsedInput.password,
    })
    if (error) return { error: authMessage(error.code) }
    // The shop's SEC-4: a new device gets a security email (the sign-in is shared).
    if (data.user) await noteSignIn(data.user.id, (await headers()).get('user-agent'))

    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_MAIL_URL)
    // With two-factor on, a sign-in is not finished until the code.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      redirect(`/verify?next=${encodeURIComponent(next)}`)
    }
    redirect(next)
  })

export const signUp = actionClient
  .inputSchema(signUpSchema)
  .action(async ({ parsedInput }): Promise<Failure | { sentTo: string }> => {
    const refused = await refuseBots(parsedInput.turnstileToken)
    if (refused) return refused
    const supabase = await createClient()
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_MAIL_URL)
    const { error } = await supabase.auth.signUp({
      email: parsedInput.email,
      password: parsedInput.password,
      // The hook words this as Mail's email, and its link lands on `next`.
      options: { emailRedirectTo: mailUrl(next), data: { full_name: parsedInput.fullName } },
    })
    // An address that already has an account gets the same answer as a new
    // one, so the form cannot be used to find out who has an account.
    if (error) return { error: authMessage(error.code) }
    return { sentTo: parsedInput.email }
  })

export const resendConfirmation = actionClient
  .inputSchema(emailOnlySchema)
  .action(async ({ parsedInput }): Promise<Failure | { sentTo: string }> => {
    const refused = await refuseBots(parsedInput.turnstileToken)
    if (refused) return refused
    const supabase = await createClient()
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_MAIL_URL)
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: parsedInput.email,
      options: { emailRedirectTo: mailUrl(next) },
    })
    if (error) return { error: authMessage(error.code) }
    return { sentTo: parsedInput.email }
  })

export const requestPasswordReset = actionClient
  .inputSchema(emailOnlySchema)
  .action(async ({ parsedInput }): Promise<Failure | { sentTo: string }> => {
    const refused = await refuseBots(parsedInput.turnstileToken)
    if (refused) return refused
    const supabase = await createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(parsedInput.email, {
      redirectTo: mailUrl('/reset-password'),
    })
    // Only a rate limit is worth reporting: "no such account" must look like
    // success, or the form becomes a way to test addresses.
    if (error?.code?.startsWith('over_')) return { error: authMessage(error.code) }
    return { sentTo: parsedInput.email }
  })

export const signOut = partialAuthAction.action(async ({ ctx }) => {
  // This device only — signing out everywhere is a separate, deliberate choice.
  await ctx.supabase.auth.signOut({ scope: 'local' })
  redirect('/')
})
