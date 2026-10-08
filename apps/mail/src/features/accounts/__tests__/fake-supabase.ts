import { vi } from 'vitest'

/**
 * A session client double for the accounts feature, shaped like the calls it
 * makes: tables answer through a chain (select, eq, is, gt, order, limit →
 * awaited, or maybeSingle), and RPCs through one function per name. Every
 * call is recorded, so a test can prove what reached the database.
 */

export type Answer = { data: unknown; error: unknown; count?: number | null }

type TableAnswers = { rows?: Answer; single?: Answer }

export function fakeSupabase({
  user = { id: 'user-1', email: 'ada@example.com' } as { id: string; email?: string } | null,
  role = 'owner' as string | null,
  tables = {} as Record<string, TableAnswers>,
  rpc = {} as Record<string, (args: Record<string, unknown>) => Answer>,
} = {}) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []

  function from(table: string) {
    const answers: TableAnswers =
      table === 'members' && !tables.members
        ? { single: { data: role ? { role } : null, error: null } }
        : (tables[table] ?? {})
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'is', 'gt', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      }
    }
    chain.maybeSingle = async () => answers.single ?? { data: role ? { role } : null, error: null }
    // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited
    chain.then = (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(answers.rows ?? { data: [], error: null, count: 0 }).then(resolve, reject)
    return chain
  }

  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: vi.fn(from),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      const answer = rpc[fn]
      return answer ? answer(args) : { data: null, error: { code: 'PGRST202' } }
    }),
  }
  return { client, calls, rpcCalls }
}

/** Where a Next redirect was headed — it is thrown, not returned. */
export async function redirectTarget(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? ''
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? ''
    throw error
  }
  throw new Error('expected a redirect')
}

export const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
export const OTHER_USER = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'
export const INVITE = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
