import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { BUSINESS } from '@/lib/business'
import { QUICKSTART_PATH } from '../lib/site'

const LINK =
  'rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * /docs until the docs package lands (MAIL-SPEC §6 "Docs"): a link to the
 * quickstart once it exists, and until then, where the one call is shown.
 * No API reference here — that is generated from the schemas, elsewhere.
 */
export function DocsLanding({
  quickstartPath = QUICKSTART_PATH,
}: {
  quickstartPath?: string | null
}) {
  return (
    <section aria-labelledby="docs-start-heading">
      <Container className="py-12 sm:py-16">
        <div className="max-w-2xl rounded-[2rem] border border-brand-subtle-border bg-card p-7 sm:p-10">
          <h2 id="docs-start-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Start here
          </h2>
          {quickstartPath ? (
            <>
              <p className="mt-3 text-pretty text-muted-foreground">
                The quickstart takes you from a verified domain to your first email.
              </p>
              <Link
                href={quickstartPath}
                className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
              >
                Read the quickstart
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </>
          ) : (
            <>
              <p className="mt-3 text-pretty text-muted-foreground">
                The quickstart is being written, and this page will link to it as soon as it is
                ready.
              </p>
              <p className="mt-3 text-pretty text-muted-foreground">
                Until then, the request that sends an email is on the{' '}
                <Link href="/#send-example" className={LINK}>
                  home page
                </Link>
                , and{' '}
                <a href={`mailto:${BUSINESS.email}`} className={LINK}>
                  {BUSINESS.email}
                </a>{' '}
                answers questions.
              </p>
            </>
          )}
        </div>
      </Container>
    </section>
  )
}
