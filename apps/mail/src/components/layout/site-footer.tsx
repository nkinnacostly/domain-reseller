import { Brand } from './brand'
import { Container } from './container'

/** The operator, as the shop names it, and the way back to the shop. */
export function SiteFooter() {
  return (
    <footer className="mt-auto bg-footer text-footer-foreground">
      <Container className="flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <Brand tone="onFooter" />
        <p className="text-sm text-footer-muted-foreground">
          CLOOP UNIVERSE TECH, trading as{' '}
          <a
            href="https://www.mydomainshub.com"
            className="rounded-sm text-footer-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-footer-foreground"
          >
            MyDomainsHub
          </a>
          .
        </p>
      </Container>
    </footer>
  )
}
