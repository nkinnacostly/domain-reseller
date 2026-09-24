import type { MetadataRoute } from 'next'
import { robotsRules } from '@/features/seo/lib/robots'
import { env } from '@/lib/env'

/** robots.txt — the rules and why are in features/seo/lib/robots.ts. */
export default function robots(): MetadataRoute.Robots {
  return robotsRules(env.NEXT_PUBLIC_APP_URL)
}
