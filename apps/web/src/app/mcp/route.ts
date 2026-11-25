import { handleMcp, RPC, rpcError } from '@/features/mcp/lib/protocol'
import { MCP_TOOLS } from '@/features/mcp/queries/tools'

/**
 * /mcp — MyDomainsHub's MCP server (feature 8), for AI assistants: search,
 * prices and a cart link, read-only. Not an app mutation: nothing here writes
 * a cart, an order or an account; the person does that on the site.
 */

const MAX_BYTES = 64 * 1024
const JSON_HEADERS = { 'Cache-Control': 'no-store' }

export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) {
    const reply = rpcError(null, RPC.invalidRequest, 'Request too large.', 413)
    return Response.json(reply.body, { status: reply.status, headers: JSON_HEADERS })
  }
  let message: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BYTES) throw new Error('too large')
    message = JSON.parse(text)
  } catch {
    const reply = rpcError(null, RPC.parse, 'Expected one JSON-RPC message as JSON.', 400)
    return Response.json(reply.body, { status: reply.status, headers: JSON_HEADERS })
  }
  const reply = await handleMcp(message, MCP_TOOLS)
  if (reply.body === null) return new Response(null, { status: reply.status })
  return Response.json(reply.body, { status: reply.status, headers: JSON_HEADERS })
}

/** No server-to-client stream: every answer comes back on its POST. */
export function GET() {
  return new Response('MyDomainsHub MCP server: send JSON-RPC requests with POST.', {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
