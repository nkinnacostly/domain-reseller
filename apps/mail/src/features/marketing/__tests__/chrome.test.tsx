import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_NAME } from '@/components/layout/brand'
import { ThemeProvider } from '@/components/layout/theme-provider'
import { CopyrightYear, LAUNCH_YEAR, MarketingFooter } from '../components/marketing-footer'
import { MarketingHeader } from '../components/marketing-header'

const pathname = vi.hoisted(() => ({ current: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))

const header = () =>
  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <MarketingHeader />
    </ThemeProvider>,
  )

afterEach(() => {
  pathname.current = '/'
  vi.useRealTimers()
})

describe('the public header', () => {
  it('links home by name, then Pricing, Docs, Sign in and Get started', () => {
    header()
    expect(screen.getByRole('link', { name: `${PRODUCT_NAME}, home` })).toHaveAttribute('href', '/')
    const main = screen.getByRole('navigation', { name: 'Main' })
    expect(within(main).getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing')
    expect(within(main).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs')
    const banner = screen.getByRole('banner')
    expect(within(banner).getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute(
      'href',
      '/sign-in',
    )
    expect(within(banner).getAllByRole('link', { name: 'Get started' })[0]).toHaveAttribute(
      'href',
      '/sign-up',
    )
  })

  it('marks the page you are on (S13)', () => {
    pathname.current = '/pricing'
    header()
    const main = screen.getByRole('navigation', { name: 'Main' })
    expect(within(main).getByRole('link', { name: 'Pricing' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(main).getByRole('link', { name: 'Docs' })).not.toHaveAttribute('aria-current')
  })

  it('opens and closes the phone menu, naming what a press does', () => {
    header()
    const menu = document.getElementById('mobile-nav')
    expect(menu).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(menu).not.toHaveAttribute('hidden')
    const mobile = screen.getByRole('navigation', { name: 'Mobile' })
    expect(within(mobile).getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    fireEvent.click(within(mobile).getByRole('link', { name: 'Get started' }))
    expect(menu).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }))
    expect(menu).toHaveAttribute('hidden')
  })

  it('switches the theme from the blue panel (S3)', () => {
    header()
    fireEvent.click(screen.getByRole('button', { name: 'Use the dark theme' }))
    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('button', { name: 'Use the light theme' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use the light theme' }))
  })
})

describe('the public footer', () => {
  it('names the operator, its RC number and the shop, and lists every public page', () => {
    render(<MarketingFooter year="2026" />)
    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent(
      '© 2026 CLOOP UNIVERSE TECH LTD (RC 9771867), trading as MyDomainsHub.',
    )
    expect(within(footer).getByRole('link', { name: 'MyDomainsHub' })).toHaveAttribute(
      'href',
      'https://www.mydomainshub.com',
    )
    expect(within(footer).getByRole('link', { name: 'Buy a domain name' })).toHaveAttribute(
      'href',
      'https://www.mydomainshub.com',
    )
    const nav = within(footer).getByRole('navigation', { name: 'Footer' })
    for (const href of [
      '/pricing',
      '/docs',
      '/contact',
      '/abuse',
      '/legal/terms',
      '/legal/acceptable-use',
      '/legal/privacy',
      '/legal/dpa',
      '/legal/sub-processors',
    ]) {
      expect(nav.querySelector(`a[href="${href}"]`), href).not.toBeNull()
    }
    expect(within(footer).getByRole('link', { name: 'hello@mydomainshub.com' })).toHaveAttribute(
      'href',
      'mailto:hello@mydomainshub.com',
    )
  })

  it('reads the year at request time, as a range once past the launch year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2028-03-01T12:00:00Z'))
    render(<p>{await CopyrightYear()}</p>)
    expect(screen.getByText(`${LAUNCH_YEAR}–2028`)).toBeInTheDocument()
  })

  it('shows the launch year alone in the launch year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    render(<p data-testid="year">{await CopyrightYear()}</p>)
    expect(screen.getByTestId('year')).toHaveTextContent(/^2026$/)
  })
})
