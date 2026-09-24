import { getLlmsTxt } from '@/features/seo/queries/llms'

/** /llms.txt — the site in Markdown for language models (llmstxt.org). */
export async function GET() {
  return new Response(await getLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
