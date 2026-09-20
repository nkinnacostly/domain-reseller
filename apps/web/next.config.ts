import type { NextConfig } from 'next'

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
