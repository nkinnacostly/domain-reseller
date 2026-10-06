import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Brand, BrandMark, MARK_PATH, PRODUCT_NAME } from './brand'
import { Container } from './container'
import { isCurrentPath } from './nav-link'
import { SiteFooter } from './site-footer'
import { NAV, SiteHeader } from './site-header'
import { ThemeProvider } from './theme-provider'
import { ThemeToggle } from './theme-toggle'

const pathname = vi.hoisted(() => ({ current: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))

describe('Brand (.claude/skills/mydomainshub-brand)', () => {
  it('names the product in text, with the mark hidden from screen readers', () => {
    const { container } = render(<Brand />)
    expect(container).toHaveTextContent('MyDomainsHub Mail')
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws the shop’s M-with-a-dot, the same path as Mail’s icon and the shop’s', () => {
    const { container } = render(<BrandMark tone="onBrand" />)
    expect(container.querySelector('path')).toHaveAttribute('d', MARK_PATH)
    expect(container.querySelector('rect')).toHaveClass('fill-brand-foreground')
    for (const file of ['src/app/icon.svg', '../web/src/app/icon.svg']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), file).toContain(MARK_PATH)
    }
  })
})

describe('the shell', () => {
  it('the header links home by name and marks the page you are on (S13)', () => {
    pathname.current = '/dashboard'
    render(<SiteHeader />)
    expect(screen.getByRole('link', { name: `${PRODUCT_NAME}, home` })).toHaveAttribute('href', '/')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
    expect(NAV.map((item) => item.href)).toEqual(['/dashboard'])
  })

  it('a link elsewhere is not current', () => {
    pathname.current = '/'
    render(<SiteHeader />)
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('the footer names the operator and links back to the shop', () => {
    render(<SiteFooter />)
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'CLOOP UNIVERSE TECH, trading as MyDomainsHub',
    )
    expect(screen.getByRole('link', { name: 'MyDomainsHub' })).toHaveAttribute(
      'href',
      'https://www.mydomainshub.com',
    )
  })

  it('every section shares one gutter (S4)', () => {
    const { container } = render(<Container className="py-4">x</Container>)
    expect(container.firstElementChild).toHaveClass('mx-auto', 'max-w-7xl', 'px-5', 'py-4')
  })

  it('the theme toggle names what a press does, and does it (S3)', () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <ThemeToggle />
      </ThemeProvider>,
    )
    const button = screen.getByRole('button', { name: 'Use the dark theme' })
    fireEvent.click(button)
    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('button', { name: 'Use the light theme' })).toBeInTheDocument()
  })
})

describe('isCurrentPath', () => {
  it('matches a section and its pages, but not a jump on the same page', () => {
    expect(isCurrentPath('/dashboard', '/dashboard/emails')).toBe(true)
    expect(isCurrentPath('/dashboard', '/dashboards')).toBe(false)
    expect(isCurrentPath('/dashboard', '/dashboard/emails', true)).toBe(false)
    expect(isCurrentPath('/', '/dashboard')).toBe(false)
    expect(isCurrentPath('/#pricing', '/')).toBe(false)
    expect(isCurrentPath('#pricing', '/')).toBe(false)
  })
})
