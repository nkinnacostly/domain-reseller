import { logger } from '@/lib/logger'

/**
 * A read asked once more when the connection dropped before any answer
 * (MAIL-SPEC §11). Node's fetch (undici) can reuse a keep-alive socket the far
 * side has just closed; the request then fails with "other side closed"
 * (`UND_ERR_SOCKET`), `UND_ERR_CLOSED`, `ECONNRESET` or `EPIPE` — no HTTP
 * answer at all. Seen in e2e after a minute on Flutterwave's page. Every
 * Supabase client Mail builds on the server sends through this wrapper
 * (`global.fetch`); the browser builds none.
 *
 * Asked again — once, straight away, with the same body and the same signal —
 * only when the first try threw one of those errors AND the request is a read:
 *   - GET or HEAD to `/rest/v1/…`: a table read (`.select()`), or an RPC sent
 *     with `{ get: true }`. PostgREST runs GET and HEAD in a read-only
 *     transaction, so a second one cannot write.
 *   - POST to `/rest/v1/rpc/<name>` when `<schema>.<name>` is in
 *     READ_ONLY_RPCS below — the schema is the `Content-Profile` supabase-js
 *     sends (PostgREST's default, `public`, when there is none), so a writer of
 *     the same name in another schema is never taken for a reader.
 *
 * Never asked again:
 *   - any HTTP answer, whatever its status. A 500 or a 503 reached the server:
 *     its word stands. (postgrest-js has its own policy for a GET's 503/520.)
 *   - every other POST, and every PATCH, PUT and DELETE — inserts, upserts,
 *     updates, deletes and any RPC not listed. A write that may have reached
 *     the database is never sent twice (the rule behind N3).
 *   - every `/auth/v1` call (sign-in, sign-up, a token refresh — a refresh
 *     token is spent on use, so sending it twice can end the session),
 *     `/storage/v1` and `/functions/v1`.
 *   - an abort (the caller's signal) or a timeout, and any other network
 *     failure — a refused connection, DNS, TLS (Node 26.8's BAD_RECORD_MAC,
 *     CLAUDE.md §15) — which a second try would not cure and would only hide.
 *
 * Even a reset can come after the server had the request; that is why only
 * reads qualify, not why they do. postgrest-js 2.116 also retries a GET or HEAD
 * that threw, up to 3 times after 1s, 2s and 4s — never a POST. This wrapper
 * sits beneath that: a dropped GET is asked again at once instead of a second
 * later, and the listed RPCs, which the library never retries, are covered.
 *
 * A retry is logged with the method, the path's kind (`rest`, `rpc:<name>`)
 * and the error's code — never a query string, a body or a header (N13).
 */

/**
 * The SQL functions a POST to `/rest/v1/rpc/<name>` may be sent twice for, as
 * `<schema>.<name>`. Each is declared `stable`, only selects, and calls only
 * functions that do the same — no insert, update or delete, no audit row, no
 * `last_used_at` stamp. `__tests__/retry.test.ts` reads the migrations and
 * holds every entry to that. Left out on purpose: `authenticate_key` (stamps
 * the key's last use), every `admin_*` action (writes the audit log), and every
 * other RPC Mail calls (each writes).
 */
export const READ_ONLY_RPCS: readonly string[] = Object.freeze([
  // Schema mail, as the signed-in member (RLS; migrations 44–50).
  'mail.account_usage', // 46: today's caps and counts for the Overview
  'mail.account_members', // 46: the account's members, for Settings
  'mail.invite_preview', // 46: what an invitation is for, before it is accepted
  'mail.account_emails', // 48: the dashboard's email log, a page at a time
  'mail.billing_overview', // 50: the billing page's plan, period and prices
  // Schema mail, by the v1 API with the secret key (a key's account; 47–48).
  'mail.api_list_domains', // 47: GET /domains
  'mail.api_get_domain', // 47: GET /domains/{id}, and the read before a verify
  'mail.api_list_keys', // 48: GET /api-keys
  'mail.get_email', // 44, redefined in 48: GET /emails/{id}
  'mail.list_emails', // 48: GET /emails
  // Schema mail, by the billing server with the secret key (50).
  'mail.flutterwave_plan_for', // the plan object a plan should have at Flutterwave
  'mail.billing_provider_state', // what Flutterwave holds for an account
  // Schema public: the shop's admin gate (40), asked by the proxy on every
  // signed-in page and by the admin pages.
  'public.admin_status', // a word for the proxy: ok, needs_code, not_admin…
  'public.admin_whoami', // the admin's principal
  // Schema public: the admin console's Mail reads (51). The actions beside
  // them (approve, reject, pause, resume, override caps) write and are not here.
  'public.admin_mail_overview',
  'public.admin_mail_review_queue',
  'public.admin_mail_accounts',
  'public.admin_mail_account',
  'public.admin_mail_domains',
  'public.admin_mail_ses_health',
  'public.admin_mail_audit',
  // Schema public: the admin's billing incidents, read-only (54).
  'public.admin_mail_billing_incidents',
])

const READ_ONLY = new Set(READ_ONLY_RPCS)

/** Errors that mean the socket was gone before any answer came back. */
const DROPPED_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE'])

/** Never asked again: the caller gave up, or something waited too long. */
const GIVEN_UP = new Set(['AbortError', 'TimeoutError'])

type Failure = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }

/**
 * The code of a dropped connection, walking `cause` (fetch throws a TypeError
 * "fetch failed" whose cause is undici's error), or null for anything else.
 */
export function droppedConnection(error: unknown): string | null {
  let found: string | null = null
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const { name, code, message, cause } = current as Failure
    if (typeof name === 'string' && GIVEN_UP.has(name)) return null
    if (typeof code === 'string' && code === 'ABORT_ERR') return null
    if (!found && typeof code === 'string' && DROPPED_CODES.has(code)) found = code
    if (!found && typeof message === 'string' && /other side closed/i.test(message)) {
      found = 'other_side_closed'
    }
    current = cause
  }
  return found
}

/** A Request, from this realm or another (a URL has no `clone`). */
function isRequest(input: unknown): input is Request {
  return (
    typeof input === 'object' && input !== null && typeof (input as Request).clone === 'function'
  )
}

/** The path's kind for a request that may be asked twice, or null. */
export function readKind(url: string, method: string, headers: Headers): string | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const rest = /\/rest\/v1\/(.+)$/.exec(pathname)
  if (!rest?.[1]) return null
  const rpc = /^rpc\/([A-Za-z0-9_]+)$/.exec(rest[1])?.[1]
  if (method === 'GET' || method === 'HEAD') return rpc ? `rpc:${rpc}` : 'rest'
  if (method !== 'POST' || !rpc) return null
  const schema = headers.get('content-profile') ?? 'public'
  return READ_ONLY.has(`${schema}.${rpc}`) ? `rpc:${rpc}` : null
}

/**
 * The same request twice over: a Request is cloned before it is sent (its
 * body can be read once), and a streamed body is read into memory first.
 */
async function twice(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<[Parameters<typeof fetch>, Parameters<typeof fetch>]> {
  let body = init?.body
  if (body instanceof ReadableStream) body = await new Response(body).arrayBuffer()
  const sent = init && body !== init.body ? { ...init, body } : init
  const first = isRequest(input) ? input.clone() : input
  return [
    [first, sent],
    [input, sent],
  ]
}

/** `fetch`, looked up when called — as supabase-js does — so a patched one is honoured. */
const globalFetch: typeof fetch = (input, init) => fetch(input, init)

/** Wraps `base` so a dropped read is asked once more (see the file's header). */
export function retryingFetch(base: typeof fetch = globalFetch): typeof fetch {
  return async (input, init) => {
    const request = isRequest(input) ? input : null
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? request?.headers)
    const kind = readKind(request ? request.url : String(input), method, headers)
    if (!kind) return base(input, init)

    const [first, second] = await twice(input, init)
    try {
      return await base(...first)
    } catch (error) {
      const code = droppedConnection(error)
      if (!code || (init?.signal ?? request?.signal)?.aborted) throw error
      logger.warn({ method, kind, code }, 'a Supabase read lost its connection; asking once more')
      return base(...second)
    }
  }
}
