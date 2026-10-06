import 'server-only'

import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { CURRENT_ACCOUNT_COOKIE, CURRENT_ACCOUNT_MAX_AGE } from '../lib/current'

/**
 * Remembers which account the dashboard shows. Only a preference — membership
 * is read on every request (lib/current.ts) — but httpOnly all the same: no
 * script needs it.
 */
export async function rememberAccount(accountId: string): Promise<void> {
  ;(await cookies()).set(CURRENT_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: CURRENT_ACCOUNT_MAX_AGE,
  })
}

export async function forgetAccount(): Promise<void> {
  ;(await cookies()).delete(CURRENT_ACCOUNT_COOKIE)
}
