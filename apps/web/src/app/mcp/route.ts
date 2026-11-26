import { answerMcpDelete, answerMcpGet, answerMcpPost } from '@/features/mcp/lib/http'
import { MCP_TOOLS } from '@/features/mcp/queries/tools'

/**
 * /mcp — MyDomainsHub's MCP server (feature 8), for AI assistants: search,
 * prices and a cart link, read-only. Listed in Claude's directory.
 */
export function POST(request: Request) {
  return answerMcpPost(request, MCP_TOOLS)
}

export function GET() {
  return answerMcpGet()
}

export function DELETE() {
  return answerMcpDelete()
}
