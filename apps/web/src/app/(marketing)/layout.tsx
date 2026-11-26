import { SiteAssistant } from '@/features/assistant/components/site-assistant'
import { isAiEnabled } from '@/lib/ai'

/**
 * Every public page, with the site assistant's button in the corner while the
 * AI features are on (AI phase 5). Adds no wrapper: each page keeps its own
 * header, hero and footer.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      {isAiEnabled() ? <SiteAssistant /> : null}
    </>
  )
}
