import 'server-only'

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * The signed-in account, for the panel. Reads as the user (RLS applies) and
 * is request-scoped — never cached across requests (CLAUDE.md §8).
 */
export const getAccount = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const [{ data: profile }, { data: factors }, { data: aal }] = await Promise.all([
    supabase
      .from('profiles')
      .select('full_name, phone, password_reset_at')
      .eq('id', user.id)
      .single(),
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ])

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: profile?.full_name ?? '',
    phone: profile?.phone ?? '',
    passwordResetAt: profile?.password_reset_at ?? null,
    totpFactor: factors?.totp.find((factor) => factor.status === 'verified') ?? null,
    assurance: aal?.currentLevel ?? 'aal1',
    methods: aal?.currentAuthenticationMethods ?? [],
  }
})

export type Account = NonNullable<Awaited<ReturnType<typeof getAccount>>>
