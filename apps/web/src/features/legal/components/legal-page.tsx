import { NavLink } from '@/components/layout/nav-link'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'
import { LEGAL_DOCUMENTS } from '../lib/documents'

/**
 * The frame every legal and help page shares: one heading, a plain reading
 * column, and the other documents beside it. Legal text is read slowly and
 * quoted back, so it gets full-contrast body text and generous spacing.
 */

const PROSE = cn(
  'text-pretty text-[0.95rem]/7 text-foreground',
  '[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5',
  '[&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5',
  '[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground/80',
  '[&_strong]:font-semibold',
)

export function LegalPage({
  title,
  intro,
  children,
  nav = 'legal',
}: {
  title: string
  intro?: React.ReactNode
  children: React.ReactNode
  /** Legal documents list the others beside them; help pages do not. */
  nav?: 'legal' | 'none'
}) {
  return (
    <>
      <SiteHeader className="border-border/60 border-b" />
      <main id="main">
        <Container className="py-12 sm:py-16">
          <div
            className={cn(
              'grid gap-12',
              nav === 'legal' && 'lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-16',
            )}
          >
            <article className="max-w-3xl min-w-0">
              <p className="text-sm text-muted-foreground">Last updated {BUSINESS.lastUpdated}</p>
              <h1 className="mt-2 text-[2rem] leading-[1.1] font-bold tracking-[-0.02em] text-balance sm:text-4xl">
                {title}
              </h1>
              {intro ? (
                <div className="mt-5 text-pretty text-lg/8 text-muted-foreground">{intro}</div>
              ) : null}
              <div className={cn('mt-10 space-y-10', PROSE)}>{children}</div>
            </article>

            {nav === 'legal' ? (
              <nav aria-label="Legal documents" className="lg:pt-10">
                <h2 className="text-sm font-semibold text-foreground">Legal documents</h2>
                <ul className="mt-3 space-y-1 text-sm">
                  {LEGAL_DOCUMENTS.map((document) => (
                    <li key={document.href}>
                      <NavLink
                        href={document.href}
                        exact
                        className="block rounded-md py-2 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        activeClassName="font-semibold text-foreground underline"
                      >
                        {document.title}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}

/** One numbered-free section with an anchor, so a clause can be linked to. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <h2 id={id} className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A link out to an official text: opens in a new tab and says so. */
export function PolicyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** The contact address as a link people can copy or click. */
export function EmailLink() {
  return <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>
}
