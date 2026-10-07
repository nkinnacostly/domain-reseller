import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpResponse, http } from 'msw'
import { cookies, headers } from 'next/headers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { server } from '../../../../tests/mocks/server'
import { mockRpc, SUPABASE_URL } from '../../../../tests/mocks/supabase'
import { createPublicClient } from '../public'
import { READ_ONLY_RPCS, retryingFetch } from '../retry'
import { createClient } from '../server'
import { createServiceClient } from '../service'

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }))

/**
 * A read whose connection dropped before any answer is asked once more; a
 * write, an Auth call or anything that got an answer never is (MAIL-SPEC §11).
 */

const REST = `${SUPABASE_URL}/rest/v1`

/** What undici throws for a keep-alive socket the far side already closed. */
function dropped(code = 'UND_ERR_SOCKET', message = 'other side closed') {
  const cause = Object.assign(new Error(message), { name: 'SocketError', code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

type Answer = Response | Error

/** A stand-in for the network: answers in order, recording what was sent. */
function network(...answers: Answer[]) {
  const sent: { url: string; method: string; body: unknown; signal: AbortSignal | null }[] = []
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === 'object' && 'clone' in input ? input : null
    sent.push({
      url: request ? request.url : String(input),
      method: init?.method ?? request?.method ?? 'GET',
      body: request ? await request.text() : init?.body,
      signal: init?.signal ?? null,
    })
    const answer = answers.shift() ?? Response.json([])
    if (answer instanceof Error) throw answer
    return answer
  })
  return { fetch: retryingFetch(base as unknown as typeof fetch), sent }
}

const rpc = (name: string, schema = 'mail') => ({
  url: `${REST}/rpc/${name}`,
  init: {
    method: 'POST',
    headers: { 'Content-Profile': schema, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_account_id: 'a1b2' }),
  } satisfies RequestInit,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a read whose connection dropped', () => {
  it('is asked once more, and the second answer is the one returned', async () => {
    const { fetch, sent } = network(dropped(), Response.json([{ id: 1 }]))
    const response = await fetch(`${REST}/invoices?select=*`, { method: 'GET' })
    expect(await response.json()).toEqual([{ id: 1 }])
    expect(sent).toHaveLength(2)
  })

  it('is asked only once more: a second failure is thrown', async () => {
    const second = dropped('ECONNRESET', 'read ECONNRESET')
    const { fetch, sent } = network(dropped(), second)
    await expect(fetch(`${REST}/invoices?select=*`)).rejects.toBe(second)
    expect(sent).toHaveLength(2)
  })

  it.each([
    ['undici’s closed client', dropped('UND_ERR_CLOSED', 'The client is destroyed')],
    ['a reset', dropped('ECONNRESET', 'read ECONNRESET')],
    ['a broken pipe', dropped('EPIPE', 'write EPIPE')],
    ['"other side closed" with no code', dropped('', 'other side closed')],
  ])('counts %s as dropped', async (_, error) => {
    const { fetch, sent } = network(error, Response.json([]))
    expect((await fetch(`${REST}/plans?select=*`, { method: 'HEAD' })).ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('asks a listed read-only RPC again with the same body and the same signal', async () => {
    const { url, init } = rpc('billing_overview')
    const signal = new AbortController().signal
    const { fetch, sent } = network(dropped(), Response.json({ plan: null }))
    expect(await (await fetch(url, { ...init, signal })).json()).toEqual({ plan: null })
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body).toBe(init.body)
    expect(sent[1]?.signal).toBe(signal)
    expect(sent[0]?.signal).toBe(signal)
  })

  it('sends a Request’s body again, and a streamed body read once into memory', async () => {
    const { url, init } = rpc('account_usage')
    const asRequest = network(dropped(), Response.json({}))
    await asRequest.fetch(new Request(url, init))
    expect(asRequest.sent.map((s) => s.body)).toEqual([init.body, init.body])

    const streamed = network(dropped(), Response.json({}))
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(init.body))
        controller.close()
      },
    })
    await streamed.fetch(url, { ...init, body, duplex: 'half' } as RequestInit)
    const texts = streamed.sent.map((s) => new TextDecoder().decode(s.body as ArrayBuffer))
    expect(texts).toEqual([init.body, init.body])
  })

  it('logs the method, the kind and the code — never the query or the body (N13)', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const reads = network(dropped(), Response.json([]))
    await reads.fetch(`${REST}/members?select=*&email=eq.someone%40example.com`)
    const { url, init } = rpc('invite_preview')
    const rpcs = network(dropped('EPIPE'), Response.json({}))
    await rpcs.fetch(url, { ...init, body: JSON.stringify({ p_email: 'someone@example.com' }) })
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { method: 'GET', kind: 'rest', code: 'UND_ERR_SOCKET' },
      { method: 'POST', kind: 'rpc:invite_preview', code: 'EPIPE' },
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.com')
  })
})

describe('never sent twice', () => {
  it.each([
    ['an RPC that is not listed (it writes)', rpc('enqueue_email')],
    ['an RPC that stamps a key’s last use', rpc('authenticate_key')],
    ['a listed name in another schema', rpc('billing_overview', 'public')],
    ['an insert', { url: `${REST}/invoices`, init: { method: 'POST', body: '{}' } }],
    ['an update', { url: `${REST}/accounts?id=eq.1`, init: { method: 'PATCH', body: '{}' } }],
    ['an upsert', { url: `${REST}/accounts`, init: { method: 'PUT', body: '{}' } }],
    ['a delete', { url: `${REST}/suppressions?id=eq.1`, init: { method: 'DELETE' } }],
    [
      'an Auth sign-in',
      {
        url: `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
        init: { method: 'POST', body: '{}' },
      },
    ],
    ['an Auth read', { url: `${SUPABASE_URL}/auth/v1/user`, init: { method: 'GET' } }],
    ['a Storage read', { url: `${SUPABASE_URL}/storage/v1/object/x`, init: { method: 'GET' } }],
  ])('%s: the error is thrown after one try', async (_, { url, init }) => {
    const error = dropped()
    const { fetch, sent } = network(error, Response.json({}))
    await expect(fetch(url, init as RequestInit)).rejects.toBe(error)
    expect(sent).toHaveLength(1)
  })

  it.each([500, 503, 520])('a read that got an answer, even a %i', async (status) => {
    const { fetch, sent } = network(new Response('{}', { status }), Response.json([]))
    expect((await fetch(`${REST}/invoices?select=*`)).status).toBe(status)
    const { url, init } = rpc('billing_overview')
    const listed = network(new Response('{}', { status }), Response.json({}))
    expect((await listed.fetch(url, init)).status).toBe(status)
    expect([sent.length, listed.sent.length]).toEqual([1, 1])
  })

  it('a read the caller aborted, or one that timed out', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    const aborted = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('aborted'), { name: 'AbortError', code: 'UND_ERR_SOCKET' }),
    })
    for (const error of [abort, timeout, aborted]) {
      const { fetch, sent } = network(error, Response.json([]))
      await expect(fetch(`${REST}/invoices?select=*`)).rejects.toBe(error)
      expect(sent).toHaveLength(1)
    }

    const controller = new AbortController()
    const { fetch, sent } = network(dropped(), Response.json([]))
    controller.abort()
    await expect(fetch(`${REST}/invoices`, { signal: controller.signal })).rejects.toThrow()
    expect(sent).toHaveLength(1)
  })

  it('a read that failed some other way: refused, unresolved, TLS', async () => {
    for (const error of [
      dropped('ECONNREFUSED', 'connect ECONNREFUSED'),
      dropped('ENOTFOUND', 'getaddrinfo ENOTFOUND'),
      dropped('ERR_SSL_BAD_RECORD_MAC', 'bad record mac'),
      new TypeError('fetch failed'),
    ]) {
      const { fetch, sent } = network(error, Response.json([]))
      await expect(fetch(`${REST}/invoices?select=*`)).rejects.toBe(error)
      expect(sent).toHaveLength(1)
    }
  })
})

describe('Mail’s Supabase clients', () => {
  /** The real fetch, failing its first call as a stale socket would. */
  const dropFirst = () => vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(dropped())

  it('the session client asks billing_overview again after a dropped connection', async () => {
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [], set: vi.fn() } as never)
    vi.mocked(headers).mockResolvedValue(new Headers() as never)
    const calls = mockRpc({ billing_overview: () => ({ plan: null }) })
    const spy = dropFirst()
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('billing_overview', { p_account_id: 'a1b2' })
    expect({ data, error }).toEqual({ data: { plan: null }, error: null })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(1)
  })

  it('the service client asks a listed read again, never a write', async () => {
    const calls = mockRpc({
      flutterwave_plan_for: () => ({ planId: null }),
      enqueue_email: () => ({ id: 'e1' }),
    })
    dropFirst()
    const read = await createServiceClient().rpc('flutterwave_plan_for', {
      p_plan_code: 'starter',
      p_test_mode: true,
      p_api_host: 'api.flutterwave.com',
    })
    expect(read.error).toBeNull()

    dropFirst()
    const write = await createServiceClient().rpc('enqueue_email', {} as never)
    expect(write.data).toBeNull()
    expect(write.error?.message).toContain('fetch failed')
    expect(calls.map((call) => call.fn)).toEqual(['flutterwave_plan_for'])
  })

  it('the public client asks a table read again at once', async () => {
    let reads = 0
    server.use(
      http.get(`${REST}/plans`, () => {
        reads += 1
        return HttpResponse.json([])
      }),
    )
    dropFirst()
    // postgrest-js's own retry (a second later) is off, so this is ours.
    const { error } = await createPublicClient().from('plans').select('*').retry(false)
    expect(error).toBeNull()
    expect(reads).toBe(1)
  })
})

/** The migrations, read from disk, so the allowlist cannot drift from the SQL. */
const MIGRATIONS = join(__dirname, '../../../../../../supabase/migrations')

type SqlFunction = { file: string; volatility: string; body: string }

/** Each function's last definition across the migrations, by `schema.name`. */
function sqlFunctions(): Map<string, SqlFunction> {
  const found = new Map<string, SqlFunction>()
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const match of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(/gi,
    )) {
      const start = match.index
      const tag = /\$[a-z_]*\$/i.exec(sql.slice(start))
      if (!tag || !match[1]) continue
      const bodyStart = start + tag.index + tag[0].length
      const bodyEnd = sql.indexOf(tag[0], bodyStart)
      const declaration = `${sql.slice(start, start + tag.index)} ${sql.slice(bodyEnd, sql.indexOf(';', bodyEnd))}`
      const volatility = /\bstable\b/i.test(declaration)
        ? 'stable'
        : /\bimmutable\b/i.test(declaration)
          ? 'immutable'
          : 'volatile'
      found.set(match[1].toLowerCase(), { file, volatility, body: sql.slice(bodyStart, bodyEnd) })
    }
  }
  return found
}

/**
 * Anything that changes a row, takes a row lock or moves a sequence. Dynamic
 * SQL (`execute $q$…$q$`) sits in the body as text, so it is read the same.
 */
const WRITES =
  /\b(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|merge\s+into|truncate|for\s+(no\s+key\s+)?update|for\s+share|nextval\s*\(|setval\s*\()/i

describe('the read-only RPCs', () => {
  const functions = sqlFunctions()

  /** Why `name` is not read-only, through every function it calls; null when it is. */
  function writer(name: string, seen = new Set<string>()): string | null {
    if (seen.has(name)) return null
    seen.add(name)
    const fn = functions.get(name)
    if (!fn) return `${name} is not defined in supabase/migrations`
    if (fn.volatility === 'volatile') return `${name} (${fn.file}) is not declared stable`
    const write = WRITES.exec(fn.body)
    if (write) return `${name} (${fn.file}) has "${write[0]}"`
    for (const call of fn.body.matchAll(/\b((?:mail|public)\.[a-z_]+)\s*\(/gi)) {
      const reason = call[1] ? writer(call[1].toLowerCase(), seen) : null
      if (reason) return reason
    }
    return null
  }

  it.each([...READ_ONLY_RPCS])('%s is stable and only reads, through all it calls', (name) => {
    expect(writer(name)).toBeNull()
  })

  it('would refuse a function that writes, such as authenticate_key', () => {
    expect(writer('mail.authenticate_key')).toMatch(/not declared stable|update/)
    expect(writer('mail.enqueue_email')).not.toBeNull()
  })

  it('cannot be extended at run time', () => {
    expect(Object.isFrozen(READ_ONLY_RPCS)).toBe(true)
  })
})
