import { describe, expect, it } from 'vitest'
import { NOT_INDEXED, pageMetadata, SHARE_IMAGE } from '../lib/metadata'

describe('pageMetadata', () => {
  it('sets the canonical address and keeps the share card whole', () => {
    const metadata = pageMetadata({ title: 'Pricing', description: 'Prices.', path: '/pricing' })
    expect(metadata).toMatchObject({
      title: 'Pricing',
      description: 'Prices.',
      alternates: { canonical: '/pricing' },
      openGraph: {
        url: '/pricing',
        siteName: 'MyDomainsHub',
        locale: 'en_NG',
        type: 'website',
        images: [SHARE_IMAGE],
      },
    })
    expect(metadata).not.toHaveProperty('robots')
  })

  it('passes a page’s robots rule through', () => {
    expect(pageMetadata({ path: '/cart', robots: NOT_INDEXED }).robots).toEqual({
      index: false,
      follow: true,
    })
  })
})
