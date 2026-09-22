import { env } from '@/lib/env'

/**
 * Where an email link lands. `flow` only chooses the message shown if the
 * link fails — it grants nothing, so it is safe for it to be editable.
 */
export type EmailFlow = 'signup' | 'magiclink' | 'recovery'

export function callbackUrl(flow: EmailFlow, next: string): string {
  const url = new URL('/auth/callback', env.NEXT_PUBLIC_APP_URL)
  url.searchParams.set('flow', flow)
  url.searchParams.set('next', next)
  return url.toString()
}
