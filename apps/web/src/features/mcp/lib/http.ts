import { handleMcp, type McpTool, RPC, rpcError } from './protocol'

/**
 * The MCP server over HTTP (feature 8), shared by /mcp and /mcp/chatgpt:
 * Streamable HTTP, stateless, one JSON-RPC message per POST answered with
 * plain JSON. Not an app mutation: nothing here writes a cart, an order or an
 * account; the person does that on the site.
 */

const MAX_BYTES = 64 * 1024
const JSON_HEADERS = { 'Cache-Control': 'no-store' }

export async function answerMcpPost(
  request: Request,
  tools: readonly McpTool[],
  instructions?: string,
): Promise<Response> {
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
  const reply = await handleMcp(message, tools, instructions)
  if (reply.body === null) return new Response(null, { status: reply.status })
  return Response.json(reply.body, { status: reply.status, headers: JSON_HEADERS })
}

/** No server-to-client stream: every answer comes back on its POST. */
export function answerMcpGet(): Response {
  return new Response('MyDomainsHub MCP server: send JSON-RPC requests with POST.', {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export function answerMcpDelete(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
