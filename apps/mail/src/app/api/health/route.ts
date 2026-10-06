import { connection } from 'next/server'

/**
 * Liveness for uptime checks: the app answers, now — `connection()` keeps
 * Cache Components from prerendering it into a file that always says yes.
 * It reads nothing and says nothing else.
 */
export async function GET() {
  await connection()
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
}
