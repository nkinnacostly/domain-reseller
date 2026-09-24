import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FinalCta } from '../components/final-cta'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

describe('FinalCta', () => {
  it('closes the page with a search form of its own, told apart from the hero one', () => {
    render(<FinalCta tlds={['com', 'africa']} />)

    const section = screen.getByRole('region', { name: 'Find the name before someone else does' })
    const form = within(section).getByRole('form', { name: 'Domain search, end of page' })
    expect(within(form).getByLabelText('Find your domain')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Domain search' })).not.toBeInTheDocument()
  })

  it('orbits the first four featured extensions round the globe, and no more', () => {
    render(<FinalCta tlds={['com', 'africa', 'net', 'org', 'io']} />)

    for (const tld of ['.com', '.africa', '.net', '.org']) {
      expect(screen.getByText(tld)).toBeInTheDocument()
    }
    expect(screen.queryByText('.io')).not.toBeInTheDocument()
  })

  it('still offers the search when no extension is featured', () => {
    render(<FinalCta tlds={[]} />)

    expect(screen.getByRole('form', { name: 'Domain search, end of page' })).toBeInTheDocument()
    expect(screen.queryByText(/^\.\w+$/)).not.toBeInTheDocument()
  })
})
