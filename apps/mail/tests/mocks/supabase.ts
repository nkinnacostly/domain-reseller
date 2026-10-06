import { HttpResponse, http } from 'msw'
import { server } from './server'

/**
 * PostgREST as Mail's functions answer it (migration 44): each RPC in schema
 * `mail` is answered by a test's function, and every call is recorded with
 * its body and the schema it asked for (`Content-Profile`), so a test can
 * prove what reached the database — and that nothing personal did beyond the
 * function's own arguments.
 */

export const SUPABASE_URL = 'http://127.0.0.1:54321'

export type RpcCall = {
  fn: string
  body: Record<string, unknown>
  schema: string | null
  auth: string | null
}

type Answer = { status?: number; body: unknown }
type Responder = (body: Record<string, unknown>) => Answer | unknown

export function mockRpc(answers: Record<string, Responder>) {
  const calls: RpcCall[] = []
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/:fn`, async ({ request, params }) => {
      const fn = String(params.fn)
      const body = (await request.json()) as Record<string, unknown>
      calls.push({
        fn,
        body,
        schema: request.headers.get('content-profile'),
        auth: request.headers.get('authorization'),
      })
      const responder = answers[fn]
      if (!responder) {
        return HttpResponse.json(
          { code: 'PGRST202', message: `no mock for ${fn}` },
          { status: 404 },
        )
      }
      const answer = responder(body)
      if (answer && typeof answer === 'object' && 'body' in answer) {
        const { status = 200, body: payload } = answer as Answer
        return HttpResponse.json(payload as never, { status })
      }
      return HttpResponse.json(answer as never)
    }),
  )
  return calls
}
