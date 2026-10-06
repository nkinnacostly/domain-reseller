import { Container } from '@/components/layout/container'

/**
 * The home page, until the public pages arrive (MAIL-SPEC §13, P4). It says
 * only what is true today (N9b): the product is being built and is not open.
 */
export default function HomePage() {
  return (
    <section className="py-6 sm:py-10">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-brand px-6 py-14 text-brand-foreground sm:px-12 sm:py-20">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-brand-arc opacity-60"
          />
          <div className="relative max-w-2xl">
            <p className="text-sm font-medium text-brand-muted-foreground">MyDomainsHub Mail</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
              Transactional email for your app, sent with one HTTP call.
            </h1>
            <p className="mt-5 max-w-xl text-base/7 text-pretty text-brand-muted-foreground">
              Receipts, sign-in links and alerts, from your own domain. We are building it now, and
              it is not open for sign-up yet.
            </p>
          </div>
        </div>
      </Container>
    </section>
  )
}
