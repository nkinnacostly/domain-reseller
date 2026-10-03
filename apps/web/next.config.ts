import type { NextConfig } from 'next'
import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots'
import { ADMIN_NOT_FOUND_PATH, STRANGER_HEADER } from './src/features/admin/lib/door'
import { siteCsp, supabaseHostOf } from './src/lib/csp'

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

/** The site's policy (src/lib/csp.ts), which the proxy also gives a stranger's 404 at /admin. */
const csp = siteCsp({
  supabaseHost: supabaseHostOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
  development: process.env.NODE_ENV !== 'production',
})

/** Every path except `/admin` and below (path-to-regexp group for `source`). */
export const NOT_ADMIN = '(?!admin(?:/|$)).*'

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

  // D9: a stranger at /admin — the proxy marks the request after asking SQL
  // (features/admin/lib/door.ts) — sees Next's own 404, through a rewrite of
  // the config's, which unlike the proxy's sends back no header naming it.
  async rewrites() {
    return {
      beforeFiles: ['/admin', '/admin/:path*'].map((source) => ({
        source,
        // A value, so the match captures nothing: a bare `has` would add the
        // header to the page's query, and the 404's payload would name it.
        has: [{ type: 'header' as const, key: STRANGER_HEADER, value: '1' }],
        destination: ADMIN_NOT_FOUND_PATH,
      })),
      afterFiles: [],
      fallback: [],
    }
  },

  async headers() {
    return [
      {
        // Everywhere but /admin, which the proxy gives its own nonce policy
        // (ADMIN-SPEC §2.3): no 'unsafe-inline' for scripts there. A
        // stranger's 404 at /admin gets this one from the proxy (D9), which
        // writes names lower-case, as every Headers object does — so this
        // name is lower-case too, and the two 404s match even on HTTP/1.1.
        source: `/:path(${NOT_ADMIN})`,
        headers: [{ key: 'content-security-policy', value: csp }],
      },
      {
        source: '/:path*',
        headers: [
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
