import { MarketingFooter } from '@/features/marketing/components/marketing-footer'
import { MarketingHeader } from '@/features/marketing/components/marketing-header'

/**
 * The public, signed-out pages (MAIL-SPEC §10): their own header, floating
 * over each page's blue panel, and their own footer. The header stays a
 * banner landmark outside <main>, the page's h1 inside it (CLAUDE.md §15).
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <MarketingHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  )
}
