import type { Metadata, Viewport } from 'next'
import { Poppins } from 'next/font/google'
import { BRAND_NAME } from '@/components/layout/brand'
import { ThemeProvider } from '@/components/layout/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { INDEXABLE } from '@/features/seo/lib/metadata'
import { env } from '@/lib/env'
import './globals.css'

// Geometric sans with the tight, heavy display weights the design leans on.
const poppins = Poppins({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  // Absolute URLs for the social card (app/opengraph-image.png) and canonical links.
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  applicationName: BRAND_NAME,
  title: { default: BRAND_NAME, template: `%s · ${BRAND_NAME}` },
  description:
    'Search, register and manage domain names. Naira pricing, renewal price shown upfront, no hidden fees.',
  openGraph: { type: 'website', siteName: BRAND_NAME, locale: 'en_NG' },
  twitter: { card: 'summary_large_image' },
  // Pages opt out (the panel, results, one-time flows); everything else may be
  // found, with full snippets and large image previews.
  robots: INDEXABLE,
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The page background in each theme (--background), so the browser chrome
  // runs straight into the page.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0d191d' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" suppressHydrationWarning>
      <body className={`${poppins.variable} bg-background font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-full focus:bg-background focus:px-4 focus:py-2 focus:ring-2 focus:ring-ring"
          >
            Skip to content
          </a>
          {children}
          <Toaster richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  )
}
