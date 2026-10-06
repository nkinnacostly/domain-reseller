import type { NextConfig } from 'next'
import {
  ADMIN_NOT_FOUND_PATH,
  ADMIN_SOURCES,
  NOT_ADMIN,
  STRANGER_HEADER,
  UNANSWERED,
} from './src/features/admin/lib/door'
import { mailCsp, supabaseHostOf } from './src/lib/csp'

/**
 * MyDomainsHub Mail (docs/MAIL-SPEC.md) — the same stack and rules as the
 * shop's apps/web: Cache Components (nothing cached unless we opt in), type
 * errors fail the build, workspace packages consumed as source.
 */

/** The site's policy (src/lib/csp.ts), which the proxy also gives a stranger's 404 at /admin. */
const csp = mailCsp({
  supabaseHost: supabaseHostOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
  development: process.env.NODE_ENV !== 'production',
})

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  transpilePackages: ['@dr/shared', '@dr/db'],
  cacheComponents: true,
  experimental: {
    typedEnv: true,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [],
  },

  // MAIL-SPEC §10 (the shop's D9): a stranger at /admin — the proxy marks the
  // request after asking SQL (features/admin/lib/door.ts) — sees Mail's own
  // 404, through a rewrite of the config's, which unlike the proxy's sends
  // back no header naming it. Every other path no page answers takes the same
  // rewrite as a fallback, so an RSC request's `x-nextjs-rewritten-path` is
  // any 404's, not /admin's.
  async rewrites() {
    return {
      beforeFiles: ADMIN_SOURCES.map((source) => ({
        source,
        has: [{ type: 'header' as const, key: STRANGER_HEADER, value: '1' }],
        destination: ADMIN_NOT_FOUND_PATH,
      })),
      afterFiles: [],
      fallback: [{ source: UNANSWERED, destination: ADMIN_NOT_FOUND_PATH }],
    }
  },

  async headers() {
    return [
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
      {
        // Everywhere but /admin, which the proxy gives its own nonce policy:
        // no 'unsafe-inline' for scripts there. A stranger's 404 at /admin
        // gets this one from the proxy, whose headers Next sends after these
        // rules' — so this rule comes last, and its name is lower-case, as
        // every Headers object writes it: the two 404s then match name for
        // name, in order.
        source: `/:path(${NOT_ADMIN})`,
        headers: [{ key: 'content-security-policy', value: csp }],
      },
    ]
  },
}

export default nextConfig
