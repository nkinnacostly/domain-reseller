import { connection } from 'next/server'
import { env } from '@/lib/env'

/**
 * OpenAI's domain check for the ChatGPT plugin (AI phase 5): the token its
 * dashboard gives, exactly, as plain text — nothing else. Read at request
 * time, so a new token needs only the env var changed. With none set there
 * is nothing to prove, and the path is a 404 like any other.
 */
export async function GET() {
  await connection()
  const token = env.OPENAI_APPS_CHALLENGE
  if (!token) return new Response('Not found', { status: 404 })
  return new Response(token, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
