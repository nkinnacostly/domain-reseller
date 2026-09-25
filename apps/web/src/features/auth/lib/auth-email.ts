import { renderEmail } from '@dr/shared/email'
import { z } from 'zod'
import type { OutgoingEmail } from '@/lib/email/types'

/**
 * The emails Supabase Auth asks us to send (its Send Email hook, L1): the
 * payload in, the messages out. Pure, so every action type is tested.
 *
 * Links go to our own /auth/confirm with the token hash, which works when the
 * email is opened on another device (L2). The wording is the one the
 * templates in supabase/templates used, in the MyDomainsHub brand.
 */

export const authEmailPayloadSchema = z.object({
  user: z.looseObject({
    email: z.email(),
    new_email: z.email().nullish(),
  }),
  email_data: z.looseObject({
    email_action_type: z.string().min(1),
    token: z.string().default(''),
    token_hash: z.string().default(''),
    token_new: z.string().default(''),
    token_hash_new: z.string().default(''),
    redirect_to: z.string().default(''),
  }),
})

export type AuthEmailPayload = z.infer<typeof authEmailPayloadSchema>

export type AuthEmailPlan =
  | { kind: 'send'; emails: OutgoingEmail[] }
  /** Nothing to send for this action — we do not use it, or it carries no link. */
  | { kind: 'skip'; reason: string }

type Content = {
  heading: string
  body: string
  /** A button, or a code to type — never both. */
  action: { label: string; href: string } | { code: string }
  footer: string
}

/** The shared email layout (@dr/shared/email), which the gateway's notices use too. */
function render(content: Content): { html: string; text: string } {
  return renderEmail({
    heading: content.heading,
    blocks: [{ kind: 'text', text: content.body }],
    action: content.action,
    footer: [content.footer],
  })
}

function confirmLink(appUrl: string, tokenHash: string, type: string, next: string): string {
  const url = new URL('/auth/confirm', appUrl)
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', type)
  url.searchParams.set('next', next)
  return url.toString()
}

function email(to: string, subject: string, kind: string, content: Content): OutgoingEmail {
  return { to, subject, tags: ['auth', kind], ...render(content) }
}

export function planAuthEmail(payload: AuthEmailPayload, appUrl: string): AuthEmailPlan {
  const { user, email_data: data } = payload
  const next = data.redirect_to || '/app/domains'

  switch (data.email_action_type) {
    case 'signup':
      if (!data.token_hash) return { kind: 'skip', reason: 'no token' }
      return {
        kind: 'send',
        emails: [
          email(user.email, 'Confirm your email', 'signup', {
            heading: 'Confirm your email',
            body: 'Tap the button to confirm this is your email address and finish creating your account.',
            action: {
              label: 'Confirm my email',
              href: confirmLink(appUrl, data.token_hash, 'email', next),
            },
            footer: "If you didn't create an account, ignore this email and nothing will happen.",
          }),
        ],
      }

    case 'magiclink':
    case 'email':
      if (!data.token_hash) return { kind: 'skip', reason: 'no token' }
      return {
        kind: 'send',
        emails: [
          email(user.email, 'Your sign-in link', 'magiclink', {
            heading: 'Your sign-in link',
            body: 'Tap the button to sign in. The link works once and expires in an hour.',
            action: { label: 'Sign in', href: confirmLink(appUrl, data.token_hash, 'email', next) },
            footer:
              "If you didn't ask to sign in, ignore this email. Nobody can sign in without this link.",
          }),
        ],
      }

    case 'recovery':
      if (!data.token_hash) return { kind: 'skip', reason: 'no token' }
      return {
        kind: 'send',
        emails: [
          email(user.email, 'Reset your password', 'recovery', {
            heading: 'Reset your password',
            body: 'Tap the button to choose a new password. The link works once and expires in an hour. For your security, changes to your domains are paused for 24 hours after a reset.',
            action: {
              label: 'Choose a new password',
              href: confirmLink(appUrl, data.token_hash, 'recovery', '/reset-password'),
            },
            footer:
              "If you didn't ask to reset your password, ignore this email — your password hasn't changed.",
          }),
        ],
      }

    case 'email_change': {
      const newEmail = user.new_email
      if (!newEmail) return { kind: 'skip', reason: 'no new email' }
      // Supabase names these the wrong way round, for backward compatibility:
      // `token_hash_new` goes to the CURRENT address, `token_hash` to the NEW
      // one (Send Email hook docs, "secure email change").
      const toNew = data.token_hash
      const toCurrent = data.token_hash_new
      const emails: OutgoingEmail[] = []
      if (toNew) {
        emails.push(
          email(newEmail, 'Confirm your new email', 'email_change', {
            heading: 'Confirm your new email',
            body: `Tap the button to confirm ${newEmail} as the email address on your account.`,
            action: {
              label: 'Confirm new email',
              href: confirmLink(appUrl, toNew, 'email_change', '/app/settings'),
            },
            footer: "If you didn't ask for this change, ignore this email.",
          }),
        )
      }
      if (toCurrent) {
        emails.push(
          email(user.email, 'Confirm your email change', 'email_change', {
            heading: 'Confirm your email change',
            body: `Someone asked to change the email address on your account to ${newEmail}. Tap the button if that was you.`,
            action: {
              label: 'Confirm the change',
              href: confirmLink(appUrl, toCurrent, 'email_change', '/app/settings'),
            },
            footer: "If you didn't ask for this change, sign in and change your password now.",
          }),
        )
      }
      return emails.length > 0 ? { kind: 'send', emails } : { kind: 'skip', reason: 'no token' }
    }

    case 'reauthentication':
      if (!data.token) return { kind: 'skip', reason: 'no code' }
      return {
        kind: 'send',
        emails: [
          email(user.email, 'Your verification code', 'reauthentication', {
            heading: 'Your verification code',
            body: 'Enter this code to confirm it’s you. It expires in an hour.',
            action: { code: data.token },
            footer: "If you didn't ask for a code, change your password now.",
          }),
        ],
      }

    default:
      // Invitations and security notifications are not switched on.
      return { kind: 'skip', reason: `unused action ${data.email_action_type}` }
  }
}
