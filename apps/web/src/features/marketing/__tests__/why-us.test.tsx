import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BRAND_NAME } from '@/components/layout/brand'
import { WhyUs } from '../components/why-us'

describe('WhyUs', () => {
  it('lists the four promises the product keeps today', () => {
    render(<WhyUs rate={1500} />)

    expect(
      screen.getByRole('heading', { level: 2, name: `Why choose ${BRAND_NAME}?` }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'The renewal price, upfront',
      'Naira at a published rate',
      'Contact privacy at no charge',
      'Your domain stays yours',
    ])
  })

  it("quotes today's published rate when there is one", () => {
    render(<WhyUs rate={1533} />)

    expect(screen.getByText(/₦1,533 to the dollar today/)).toBeInTheDocument()
  })

  it('names no rate when none is active, rather than guessing one (N5b)', () => {
    render(<WhyUs rate={null} />)

    expect(
      screen.getByText(/We convert at one rate and publish it on our pricing page/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/to the dollar today/)).not.toBeInTheDocument()
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})
