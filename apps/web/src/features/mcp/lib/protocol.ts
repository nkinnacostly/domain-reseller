/**
 * MyDomainsHub's MCP server (docs: "Making AI the core of MyDomainsHub",
 * feature 8): the Model Context Protocol over Streamable HTTP, stateless,
 * answering each JSON-RPC request with plain JSON. Read-only tools — search,
 * prices and a cart link — so an assistant can help someone choose; adding
 * to the cart and paying happen on our site, by the person (N4, N9).
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
export const MCP_SERVER_INFO = { name: 'mydomainshub', title: 'MyDomainsHub', version: '1.0.0' }
export const MCP_INSTRUCTIONS =
  'Search and price domain names at MyDomainsHub, a domain registrar for Nigeria. Prices are in naira, shown with their renewal price, before VAT. This server never takes payment or changes anything. Buying happens on mydomainshub.com: create_cart_link makes a link where the person adds the names to their cart and pays.'

export type JsonSchema = Record<string, unknown>

export type ToolResult = { text: string; structured?: Record<string, unknown>; isError?: boolean }

export type McpTool = {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  annotations?: Record<string, boolean | string>
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

type Id = string | number

export type McpReply = { status: number; body: Record<string, unknown> | null }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is Id =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function rpcError(id: Id | null, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } }
}

const result = (id: Id, value: Record<string, unknown>): McpReply => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result: value },
})

/** One JSON-RPC message in, one answer out; a notification or a response is accepted with no body. */
export async function handleMcp(message: unknown, tools: readonly McpTool[]): Promise<McpReply> {
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return rpcError(null, RPC.invalidRequest, 'Expected one JSON-RPC 2.0 message.', 400)
  }
  // A notification (no id) or a response to us: nothing to answer (202).
  if (!('id' in message) || !('method' in message)) return { status: 202, body: null }
  const { id, method, params } = message
  if (!isId(id) || typeof method !== 'string') {
    return rpcError(null, RPC.invalidRequest, 'A request needs an id and a method.', 400)
  }

  switch (method) {
    case 'initialize': {
      const asked = isRecord(params) ? params.protocolVersion : undefined
      const protocolVersion =
        MCP_PROTOCOL_VERSIONS.find((version) => version === asked) ?? MCP_PROTOCOL_VERSIONS[0]
      return result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      })
    }
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, {
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      })
    case 'tools/call': {
      const name = isRecord(params) ? params.name : undefined
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) return rpcError(id, RPC.invalidParams, `Unknown tool: ${String(name)}`)
      const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {}
      try {
        const answer = await tool.run(args)
        return result(id, {
          content: [{ type: 'text', text: answer.text }],
          ...(answer.structured ? { structuredContent: answer.structured } : {}),
          isError: answer.isError === true,
        })
      } catch {
        // A tool failing is a tool result, so the assistant can say so.
        return result(id, {
          content: [
            { type: 'text', text: 'Something went wrong on our side. Try again in a minute.' },
          ],
          isError: true,
        })
      }
    }
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${method}`)
  }
}
