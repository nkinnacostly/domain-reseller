import type { Icon } from '@phosphor-icons/react'
import { BookOpenText, Code, Terminal } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/container'
import { NavLink } from '@/components/layout/nav-link'
import { PageHero } from '@/features/marketing/components/page-hero'
import { PageJsonLd } from '@/features/seo/components/json-ld'
import { cn } from '@/lib/utils'
import { DOCS_PAGES, docsPage } from './pages'

/**
 * The frame every docs page shares, inside the public pages' frame: the
 * page's heading on the blue panel, the docs' own navigation (S13: the
 * current page marked in words and weight, not colour alone), and a reading
 * column. One Container, so everything shares the page's left edge (S4).
 */

export const PROSE = cn(
  'min-w-0 max-w-3xl text-pretty text-[0.95rem]/7 text-foreground',
  '[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5',
  '[&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5',
  '[&_a]:rounded-sm [&_a]:font-medium [&_a]:text-brand-ink [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring',
  '[&_strong]:font-semibold [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:break-words',
)

export function DocsNav() {
  return (
    <nav aria-label="Docs" className="h-fit lg:sticky lg:top-8">
      <h2 className="text-sm font-semibold">Docs</h2>
      <ul className="mt-2 grid grid-cols-1 gap-x-4 text-sm min-[420px]:grid-cols-2 lg:grid-cols-1">
        {DOCS_PAGES.map((page) => (
          <li key={page.href}>
            <NavLink
              href={page.href}
              exact
              className="flex min-h-11 items-center gap-2 py-2 data-[current=true]:font-semibold data-[current=true]:text-brand-ink"
            >
              {page.title}
              {page.stub ? ' ' : null}
              {page.stub ? (
                <span className="rounded-full bg-tone-neutral px-2 py-0.5 text-[0.7rem] font-medium text-tone-neutral-foreground no-underline">
                  Soon
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function DocsFrame({
  slug,
  title,
  intro,
  icons = [BookOpenText, Terminal, Code],
  children,
}: {
  slug: string
  /** The h1, when it is not the page's name in the docs' navigation. */
  title?: string
  intro: React.ReactNode
  icons?: readonly Icon[]
  children: React.ReactNode
}) {
  const page = docsPage(slug)
  const trail = [
    { name: 'Docs', path: '/docs' },
    ...(slug ? [{ name: page.title, path: page.href }] : []),
  ]
  return (
    <>
      <PageJsonLd trail={trail} />
      <PageHero eyebrow="Docs" title={title ?? page.title} intro={intro} icons={icons} />
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-14">
          <DocsNav />
          <article className={cn(PROSE, 'space-y-12')}>{children}</article>
        </div>
      </Container>
    </>
  )
}

/** A section of a docs page, with an anchor of its own. */
export function DocsSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-8">
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight sm:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A table that scrolls inside itself, never the page (S5), and takes focus to do so. */
export function DocsTable({
  label,
  head,
  rows,
}: {
  label: string
  head: readonly string[]
  rows: readonly (readonly React.ReactNode[])[]
}) {
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
      tabIndex={0}
      aria-label={label}
      className="relative mt-4 overflow-x-auto rounded-2xl border border-border focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full border-collapse text-left text-sm/6">
        <thead className="bg-muted/60 text-xs font-semibold">
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col" className="px-4 py-2.5">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border align-top">
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed content, in order
            <tr key={index}>
              {row.map((cell, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are fixed content, in order
                <td key={column} className="px-4 py-2.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** "Not written yet": a stub page's honest notice (N9b). */
export function StubNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-stub="true"
      className="rounded-2xl bg-tone-warning p-4 text-sm/6 text-tone-warning-foreground [&_a]:text-tone-warning-foreground!"
    >
      {children}
    </div>
  )
}
