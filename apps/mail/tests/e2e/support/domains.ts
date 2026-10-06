/**
 * The domains journey's helpers: a Mail account for a test person, made as
 * them (`create_account` needs their session), and the mock SES's controls
 * (support/mock-ses.mjs) — over HTTP, never by importing it, which would
 * start a second server. Nothing here logs an address or a password.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { TestUser } from './accounts'

const MOCK_SES_URL = `http://127.0.0.1:${Number(process.env.MOCK_SES_PORT ?? 4312)}`

function publicSettings() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !publishable)
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and its publishable key must be set')
  return { url, publishable }
}

/** A Mail account owned by the test person, made with their own session (migration 43). */
export async function createAccountFor(user: TestUser, name = 'E2E Domains'): Promise<string> {
  const { url, publishable } = publicSettings()
  const client = createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signInError) throw signInError
  const { data, error } = await client.schema('mail').rpc('create_account', { p_name: name })
  await client.auth.signOut({ scope: 'local' })
  if (error || data?.ok !== true)
    throw error ?? new Error(`create_account: ${data?.code ?? 'refused'}`)
  return String(data.accountId)
}

/** SES verifies the domain, and its records are in the mock's public DNS. */
export async function verifyInMockSes(domain: string): Promise<void> {
  const response = await fetch(
    `${MOCK_SES_URL}/__control/verify?domain=${encodeURIComponent(domain)}`,
    {
      method: 'POST',
    },
  )
  if (!response.ok)
    throw new Error(`the mock SES has no identity for the domain (${response.status})`)
}

/** Whether the mock SES still holds an identity for the domain. */
export async function mockSesHas(domain: string): Promise<boolean> {
  const response = await fetch(
    `${MOCK_SES_URL}/__control/identity?domain=${encodeURIComponent(domain)}`,
  )
  return response.ok
}
