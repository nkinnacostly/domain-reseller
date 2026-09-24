import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BRAND_NAME, Brand, BrandMark } from './brand'

const MARK_PATH = 'M15 44.5V19.5L24.92 30.82M49 44.5V19.5L39.08 30.82'
const asset = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('Brand', () => {
  it('names the site in text, with the mark hidden from screen readers', () => {
    const { container } = render(<Brand />)
    expect(screen.getByText(BRAND_NAME)).toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws the mark as a white tile with a blue glyph on the blue hero', () => {
    const { container } = render(<BrandMark tone="onBrand" />)
    expect(container.querySelector('rect')).toHaveClass('fill-brand-foreground')
    expect(container.querySelector('svg')).toHaveClass('text-brand')
  })

  it('draws the same M-with-a-dot as the favicon and the published logo files', () => {
    const { container } = render(<BrandMark />)
    expect(container.querySelector('path')).toHaveAttribute('d', MARK_PATH)
    for (const file of [
      'src/app/icon.svg',
      'public/brand/mydomainshub-mark.svg',
      'public/brand/mydomainshub-logo.svg',
    ]) {
      expect(asset(file), file).toContain(MARK_PATH)
    }
  })
})
