import { getLlmsFullTxt } from '@/features/seo/queries/llms'

/** /llms-full.txt — llms.txt plus every extension's prices and the help centre's answers. */
export async function GET() {
  return new Response(await getLlmsFullTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
