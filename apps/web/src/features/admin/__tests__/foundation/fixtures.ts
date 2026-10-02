import { vi } from 'vitest'

/** What admin_whoami answers for an enrolled admin. */
export function whoami(overrides: Record<string, unknown> = {}) {
  return {
    userId: '11111111-2222-4333-8444-555555555555',
    label: 'owner',
    role: 'owner',
    testOnly: false,
    sessionHash: 'a'.repeat(64),
    factorId: '99999999-8888-4777-8666-555555555555',
    codeAt: new Date().toISOString(),
    ...overrides,
  }
}

type RpcAnswer = { data?: unknown; error?: { message: string; code?: string } | null }

/**
 * A session client as the admin actions see it: the user, rpc answers by
 * function name (a list is answered in order), and the MFA verify call.
 */
export function sessionClient({
  user = { id: '11111111-2222-4333-8444-555555555555' } as { id: string } | null,
  rpc = {} as Record<string, RpcAnswer | RpcAnswer[]>,
  verify = { error: null } as { error: { message: string } | null },
} = {}) {
  const queues = new Map(
    Object.entries(rpc).map(([name, answer]) => [
      name,
      Array.isArray(answer) ? [...answer] : answer,
    ]),
  )
  const rpcFn = vi.fn(async (name: string, _args?: unknown) => {
    const answer = queues.get(name)
    if (!answer) return { data: null, error: { message: `no mock for ${name}` } }
    const next = Array.isArray(answer) ? (answer.length > 1 ? answer.shift() : answer[0]) : answer
    return { data: next?.data ?? null, error: next?.error ?? null }
  })
  const challengeAndVerify = vi.fn(async (_args: { factorId: string; code: string }) => verify)
  return {
    client: {
      auth: {
        getUser: async () => ({ data: { user } }),
        mfa: { challengeAndVerify },
      },
      rpc: rpcFn,
    },
    rpc: rpcFn,
    challengeAndVerify,
  }
}
