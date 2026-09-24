import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageJsonLd } from '../components/breadcrumb-json-ld'

describe('PageJsonLd', () => {
  it('starts the trail at Home and adds the page’s other structured data', () => {
    const { container } = render(
      <PageJsonLd
        trail={[{ name: 'Pricing', path: '/pricing' }]}
        extra={[{ '@type': 'Thing' }, null]}
      />,
    )
    const script = container.querySelector('script[type="application/ld+json"]')
    const data = JSON.parse(script?.textContent ?? '{}')
    expect(data['@graph'].map((node: { '@type': string }) => node['@type'])).toEqual([
      'BreadcrumbList',
      'Thing',
    ])
    expect(data['@graph'][0].itemListElement.map((item: { name: string }) => item.name)).toEqual([
      'Home',
      'Pricing',
    ])
  })

  it('escapes < so a value can never close the script tag', () => {
    const { container } = render(<PageJsonLd trail={[{ name: '</script><b>x', path: '/x' }]} />)
    const html = container.querySelector('script')?.innerHTML ?? ''
    expect(html).not.toContain('</script>')
    expect(html).toContain('\\u003c/script>')
  })
})
