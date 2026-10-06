import { Hourglass } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'

/**
 * A dashboard page that is not built yet (MAIL-SPEC §10, §13): its name,
 * what it will hold — in the future tense — and that it is not here yet. It
 * claims nothing the product does today (N9b). The package that builds the
 * page replaces this in its own route; the shell does not change.
 */
export function ComingSoon({
  title,
  will,
  arrives,
}: {
  title: string
  /** What the page will show, from the spec's table: "Every email you send…". */
  will: string
  /** When, in words we can stand behind: "with sending", "before launch". */
  arrives: string
}) {
  return (
    <Container className="py-8 sm:py-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <section
        aria-labelledby="coming-soon-heading"
        className="mt-6 max-w-2xl rounded-3xl border border-dashed border-border bg-card p-6 sm:p-8"
      >
        <span className="grid size-11 place-items-center rounded-2xl bg-brand-subtle text-brand-ink">
          <Hourglass className="size-5" aria-hidden="true" />
        </span>
        <h2 id="coming-soon-heading" className="mt-4 font-semibold">
          This page is coming
        </h2>
        <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{will}</p>
        <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
          It is not built yet: it arrives {arrives}.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Back to the overview
        </Link>
      </section>
    </Container>
  )
}
