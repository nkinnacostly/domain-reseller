import { vi } from 'vitest'

/**
 * A session client double for Mail's admin: `auth` (the user and the money
 * dialog's challengeAndVerify) and `schema('public').rpc` — the shop's gate
 * and the `admin_mail_*` functions. Every RPC is recorded with its schema, so
 * a test can prove what reached SQL, and that it went through public.
 */

export type Answer = { data: unknown; error: unknown }

export const ADMIN_USER = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'
export const FACTOR = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
export const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

export const whoami = (over: Record<string, unknown> = {}) => ({
  userId: ADMIN_USER,
  label: 'owner',
  role: 'owner',
  testOnly: false,
  sessionHash: 'a'.repeat(64),
  factorId: FACTOR,
  codeAt: '2026-10-06T12:00:00Z',
  ...over,
})

export function fakeAdmin({
  user = { id: ADMIN_USER } as { id: string } | null,
  rpc = {} as Record<string, (args: Record<string, unknown>) => Answer>,
  verify = { error: null } as { error: unknown },
} = {}) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = []
  const at = (schema: string) => ({
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ schema, fn, args })
      const answer = rpc[fn]
      return answer
        ? answer(args)
        : { data: null, error: { message: `no answer for ${fn}`, code: 'PGRST202' } }
    }),
  })
  const challengeAndVerify = vi.fn(async () => verify)
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
      mfa: { challengeAndVerify },
    },
    schema: vi.fn((name: string) => at(name)),
    ...at('mail'),
  }
  return { client, calls, challengeAndVerify }
}

/** Where a Next redirect was headed, or 'NOT_FOUND' for notFound() — both are thrown. */
export async function navigation(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? ''
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? ''
    if (digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) return 'NOT_FOUND'
    throw error
  }
  throw new Error('expected a redirect or a 404')
}
