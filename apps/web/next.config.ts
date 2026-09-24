import type { NextConfig } from 'next'

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
 */
const supabase = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host
  } catch {
    return '*.supabase.co'
  }
})()

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' https://${supabase} wss://${supabase}`,
  "frame-src 'none'",
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
