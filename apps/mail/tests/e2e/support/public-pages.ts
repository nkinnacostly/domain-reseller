import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

/** Every public, signed-out page (MAIL-SPEC §10), as the sitemap lists them. */
export const PUBLIC_PAGES = [
  '/',
  '/pricing',
  '/docs',
  '/contact',
  '/abuse',
  '/legal',
  '/legal/terms',
  '/legal/acceptable-use',
  '/legal/privacy',
  '/legal/dpa',
  '/legal/sub-processors',
] as const

export const LEGAL_PAGES = PUBLIC_PAGES.filter((path) => path.startsWith('/legal/'))

/** CLAUDE.md §7: no horizontal overflow at these widths. */
export const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920] as const

/** S4: one left edge at these widths. */
export const WIDE = [1280, 1440, 1920, 2560] as const

export async function noHorizontalOverflow(page: Page) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
  }
}

/**
 * Every left edge that must line up (S4): the header's logo, the h1, the
 * footer's logo, and the content edge of every Container on the page — and
 * every block in <main> must have one, or it is setting its own gutter.
 */
export async function leftEdges(page: Page) {
  return page.evaluate(() => {
    const CONTAINER = '.mx-auto.max-w-7xl'
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }
    const contentLeft = (el: Element) =>
      Math.round(
        el.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(el).paddingLeft),
      )
    const edges: Record<string, number> = {}
    const logo = document.querySelector('header a[href="/"]')
    if (logo) edges['header logo'] = Math.round(logo.getBoundingClientRect().left)
    const h1 = document.querySelector('main h1')
    if (h1) edges.h1 = Math.round(h1.getBoundingClientRect().left)
    const footerBrand = document.querySelector('footer svg')
    if (footerBrand) edges['footer logo'] = Math.round(footerBrand.getBoundingClientRect().left)
    document.querySelectorAll(CONTAINER).forEach((el, index) => {
      if (visible(el)) edges[`container ${index}`] = contentLeft(el)
    })
    const loose = [...(document.querySelector('main')?.children ?? [])]
      .filter((el) => el.tagName !== 'SCRIPT' && visible(el))
      .filter((el) => !el.matches(CONTAINER) && !el.querySelector(CONTAINER))
      .map((el) => el.outerHTML.slice(0, 80))
    return { edges, loose }
  })
}

/**
 * The root .env, read for the publishable Supabase key only: the pricing
 * spec reads `mail.plans` as anon does, to hold the page to the rows.
 */
export function publicSupabaseEnv(): { url: string; key: string } {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key) values[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? values.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and _PUBLISHABLE_KEY are needed')
  return { url, key }
}
