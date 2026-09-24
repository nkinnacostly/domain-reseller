/**
 * The person's browser and address, passed on to Supabase Auth so their
 * sessions record them (PRD FR-A5, "device, IP, last-seen").
 *
 * Sign-in, verification and token refresh all run on our server, so without
 * these Supabase sees only us: checked against the hosted project on 24 Sept
 * 2026, a session signed in from the server was recorded as `node` at the
 * host's address, and every refresh overwrote a session's real values with
 * those. Supabase reads the user agent and the first address in
 * `x-forwarded-for`.
 */

/** Long enough for any real browser; a bound on what a client can make us send. */
const MAX_USER_AGENT = 512
/** An IPv4 or IPv6 address, nothing else — the header is passed on, not trusted blindly. */
const ADDRESS = /^[0-9a-f:.]{2,45}$/i

/**
 * The caller's address. On Vercel both headers are set from the connection,
 * and anything the client sent in them is overwritten.
 */
export function clientAddress(source: Headers): string | null {
  const address =
    source.get('x-real-ip')?.trim() || source.get('x-forwarded-for')?.split(',')[0]?.trim()
  return address && ADDRESS.test(address) ? address : null
}

export function forwardedAuthHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  const userAgent = source.get('user-agent')
  if (userAgent) headers['user-agent'] = userAgent.slice(0, MAX_USER_AGENT)
  const address = clientAddress(source)
  if (address) headers['x-forwarded-for'] = address
  return headers
}
