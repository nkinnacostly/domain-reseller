import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { HELP_TOPICS } from '@/features/legal/components/help-topics'
import { HOME_FAQS } from '@/features/marketing/components/faq'
import { POPULAR_TLDS, sortForDisplay, toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env } from '@/lib/env'
import { type LlmsInput, llmsFullTxt, llmsTxt, type PriceLine } from '../lib/llms'
import { plainText } from '../lib/plain-text'

/**
 * The llms.txt files, built from the same cached prices as the pages — the
 * `pricing` tag refreshes them together — so the figures always agree.
 */
async function inputs(): Promise<LlmsInput & { all: PriceLine[] }> {
  const priced = await getPricedCatalogue()
  if (!priced) return { site: env.NEXT_PUBLIC_APP_URL, prices: null, all: [] }

  const rows = sortForDisplay(
    priced.tlds.map(toPublicRow),
    priced.featured.map((entry) => entry.tld),
  )
  const line = (row: (typeof rows)[number]): PriceLine => ({
    tld: row.tld,
    register: row.register,
    registerYears: row.registerYears,
    renew: row.renew,
    renewYears: row.renewYears,
    transfer: row.transfer,
  })
  const leading = new Set<string>([...priced.featured.map((entry) => entry.tld), ...POPULAR_TLDS])
  return {
    site: env.NEXT_PUBLIC_APP_URL,
    prices: {
      vatPct: priced.vatPct,
      extensionCount: priced.tlds.length,
      popular: rows.filter((row) => leading.has(row.tld)).map(line),
    },
    all: [...rows].sort((a, b) => a.tld.localeCompare(b.tld)).map(line),
  }
}

export async function getLlmsTxt(): Promise<string> {
  'use cache'
  cacheTag('pricing')
  cacheLife('hours')
  return llmsTxt(await inputs())
}

export async function getLlmsFullTxt(): Promise<string> {
  'use cache'
  cacheTag('pricing')
  cacheLife('hours')
  return llmsFullTxt({
    ...(await inputs()),
    faqs: [
      {
        title: 'Common questions',
        items: HOME_FAQS.map((faq) => ({ q: faq.q, a: faq.a })),
      },
      ...HELP_TOPICS.map((topic) => ({
        title: `Help: ${topic.title}`,
        items: topic.questions.map((item) => ({ q: item.q, a: plainText(item.a) })),
      })),
    ],
  })
}
