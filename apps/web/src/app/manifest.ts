import type { MetadataRoute } from 'next'
import { BRAND_NAME } from '@/components/layout/brand'

/**
 * For "Add to home screen" and install prompts. `browser`, not `standalone`:
 * paying hands off to Flutterwave's page and back, which is a website's flow,
 * not an app's. The icons come from the brand mark (public/icons).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: 'Search, register and manage domain names, priced in naira.',
    start_url: '/',
    display: 'browser',
    background_color: '#ffffff',
    theme_color: '#155dfc',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
