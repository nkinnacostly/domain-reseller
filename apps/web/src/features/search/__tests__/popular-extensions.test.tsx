import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PopularExtensions } from '../components/popular-extensions'
import { featuredTlds } from '../lib/featured-tlds'

describe('PopularExtensions', () => {
  it('lists the Nigerian extensions first', () => {
    render(<PopularExtensions />)
    const items = screen.getAllByRole('listitem')
    // The TLD appears twice per card (wash and title), so scope to the link.
    expect(within(items[0] as HTMLElement).getByRole('link')).toHaveAttribute('href', '/domains/ng')
    expect(within(items[1] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/domains/com.ng',
    )
  })

  /** N8 — the renewal price is never hidden. This is the product's core promise. */
  it('shows a renewal price for every extension', () => {
    render(<PopularExtensions />)
    const renewals = screen.getAllByText(/Renews at/i)
    expect(renewals).toHaveLength(featuredTlds().length)
  })

  it('renders prices in naira', () => {
    render(<PopularExtensions />)
    expect(screen.getAllByText(/₦[\d,]+/).length).toBeGreaterThan(0)
  })

  it('links each extension to its own page', () => {
    render(<PopularExtensions />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/domains/ng',
      '/domains/com.ng',
      '/domains/com',
    ])
  })

  it('gives the section a heading assistive tech can navigate to', () => {
    render(<PopularExtensions />)
    expect(screen.getByRole('heading', { name: 'Popular extensions' })).toBeInTheDocument()
  })
})

describe('featuredTlds', () => {
  const featured = featuredTlds()

  it('merchandises the Nigerian extensions first', () => {
    expect(featured.map((f) => f.tld)).toEqual(['ng', 'com.ng', 'com'])
  })

  it('flags .com, where renewal costs more than the first year', () => {
    expect(featured.find((f) => f.tld === 'com')?.renewalIsHigher).toBe(true)
  })

  it('does not flag the flat-priced .ng family', () => {
    expect(featured.find((f) => f.tld === 'ng')?.renewalIsHigher).toBe(false)
    expect(featured.find((f) => f.tld === 'ng')?.firstYear).toBe(
      featured.find((f) => f.tld === 'ng')?.renewal,
    )
  })

  it('formats prices as whole naira', () => {
    for (const f of featured) expect(f.firstYear).toMatch(/^₦[\d,]+$/)
  })
})
