import { answerMcpDelete, answerMcpGet, answerMcpPost } from '@/features/mcp/lib/http'
import { MCP_INSTRUCTIONS_READ_ONLY } from '@/features/mcp/lib/protocol'
import { MCP_TOOLS_READ_ONLY } from '@/features/mcp/queries/tools'

/**
 * /mcp/chatgpt — the MCP server as submitted to ChatGPT's plugin directory
 * (AI phase 5, docs/CHATGPT-PLUGIN.md): search and prices, no cart link,
 * because OpenAI's rules forbid linking straight to a checkout.
 */
export function POST(request: Request) {
  return answerMcpPost(request, MCP_TOOLS_READ_ONLY, MCP_INSTRUCTIONS_READ_ONLY)
}

export function GET() {
  return answerMcpGet()
}

export function DELETE() {
  return answerMcpDelete()
}
