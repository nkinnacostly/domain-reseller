import type { NextConfig } from 'next'
import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots'

/**
 * Crawlers that read the HTML without running it get every page's metadata
 * in <head>, never streamed in after it (Next 15.2+ streams dynamic metadata
 * to everyone else). Next's own list covers the search engines and link
 * previewers but no AI crawler, so theirs are added: an assistant that misses
 * the title and description reads a page with no name. Extending Next's list,
 * not copying it, keeps its entries current across upgrades.
 */
export const AI_CRAWLER_UA =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|meta-externalagent|meta-externalfetcher|meta-webindexer|Amazonbot|Amzn-SearchBot|Amzn-User|DuckAssistBot|MistralAI|CCBot|YouBot|cohere-ai|Bytespider/

export const HTML_LIMITED_BOTS = new RegExp(
  `${HTML_LIMITED_BOT_UA_RE.source}|${AI_CRAWLER_UA.source}`,
  'i',
)

/**
 * Content Security Policy (PRD SEC-15). Scripts, styles and fonts come only
 * from this site; the browser talks only to this site and our Supabase
 * project. So an injected script could neither load code from elsewhere nor
 * send anything it read to another host. Payment happens on Flutterwave's own
 * page, reached by navigation, so none of its code runs here.
 *
 * `'unsafe-inline'` stays for scripts because Next's bootstrap is inline and
 * this site has no nonce plumbing; the other directives still hold. Dev adds
 * `'unsafe-eval'` for React's tooling.
 *
 * The one outside origin is Cloudflare Turnstile (SEC-9): its script and the
 * challenge frame it draws, on the forms that send email and when a search
 * asks for a check (components/common/turnstile.tsx). It talks to Cloudflare
 * from inside its own frame, so connect-src does not change.
 */
const supabase = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host
  } catch {
    return '*.supabase.co'
  }
})()

const TURNSTILE = 'https://challenges.cloudflare.com'

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${TURNSTILE}${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' https://${supabase} wss://${supabase}`,
  `frame-src ${TURNSTILE}`,
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Fail the build on type errors. Never relax this.
  // Linting runs through Biome in CI, not through Next.
  typescript: { ignoreBuildErrors: false },

  // Workspace packages are consumed as source.
  transpilePackages: ['@dr/shared', '@dr/db'],

  // Cache Components: nothing is cached unless we opt in with `use cache`.
  cacheComponents: true,

  htmlLimitedBots: HTML_LIMITED_BOTS,

  experimental: {
    typedEnv: true,
  },

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default nextConfig
