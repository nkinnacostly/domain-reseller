import type { MetadataRoute } from 'next'

/**
 * Who may crawl what (robots.txt). Everything public is open to search
 * engines and AI assistants alike — being found and recommended is the
 * point. Two kinds of path are closed:
 *
 * - Private: the panel, API routes and auth callbacks. Nothing there for a
 *   crawler, and the panel only redirects to sign-in.
 * - Live lookups: a search, a transfer check or a WHOIS query with a name in
 *   the URL calls the supplier or a registry on every fetch (CLAUDE.md: the
 *   supplier allows two requests in flight). A crawler following those links
 *   would spend that capacity on nobody. The pages themselves stay open;
 *   only the query variants are closed. Results pages are `noindex` too.
 *
 * Assistants fetching a page because a person asked them to (ChatGPT-User,
 * Claude-User, Perplexity-User…) may run a lookup: that is a person searching,
 * through their assistant.
 */

export const PRIVATE_PATHS = ['/app/', '/api/', '/auth/'] as const

export const LOOKUP_PATHS = ['/search', '/transfer?', '/whois?', '/cart'] as const

/** Bulk search's own page is a landing page; only its runs are lookups. */
const OPEN_EXCEPTIONS = ['/search/bulk$'] as const

/**
 * Crawlers that build search indexes and AI answers, and the tokens that
 * grant training use — named so the choice to welcome them is explicit (a
 * named group replaces `*` for that crawler, so each carries the full rule
 * set). Being in the models and the AI search indexes is how an assistant
 * comes to suggest us. Tokens from each operator's documentation (Sept 2026).
 */
export const AI_CRAWLERS = [
  // OpenAI: ChatGPT search, then training
  'OAI-SearchBot',
  'GPTBot',
  // Anthropic: Claude's search index, then training
  'Claude-SearchBot',
  'ClaudeBot',
  'PerplexityBot',
  // Gemini's use of pages; Google Search itself is Googlebot, under `*`
  'Google-Extended',
  // Bing's index feeds Copilot
  'bingbot',
  'Applebot',
  'Applebot-Extended',
  'meta-webindexer',
  'meta-externalagent',
  'Amzn-SearchBot',
  'Amazonbot',
  'DuckAssistBot',
  'MistralAI-Index',
  'CCBot',
] as const

/**
 * Assistants fetching a page because one person asked them to, right now.
 * Several say robots.txt may not bind them; the rules still say what we want.
 */
export const USER_AGENTS_FOR_PEOPLE = [
  'ChatGPT-User',
  'Claude-User',
  'Perplexity-User',
  'meta-externalfetcher',
  'Amzn-User',
  'MistralAI-User',
] as const

export function robotsRules(site: string): MetadataRoute.Robots {
  const crawl = {
    allow: ['/', ...OPEN_EXCEPTIONS],
    disallow: [...PRIVATE_PATHS, ...LOOKUP_PATHS],
  }
  return {
    rules: [
      { userAgent: '*', ...crawl },
      { userAgent: [...AI_CRAWLERS], ...crawl },
      { userAgent: [...USER_AGENTS_FOR_PEOPLE], allow: '/', disallow: [...PRIVATE_PATHS] },
    ],
    sitemap: new URL('/sitemap.xml', site).toString(),
  }
}
