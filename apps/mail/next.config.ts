import type { NextConfig } from 'next'
import { mailCsp, supabaseHostOf } from './src/lib/csp'

/**
 * MyDomainsHub Mail (docs/MAIL-SPEC.md) — the same stack and rules as the
 * shop's apps/web: Cache Components (nothing cached unless we opt in), type
 * errors fail the build, workspace packages consumed as source.
 */
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
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ]
  },
}

export default nextConfig
