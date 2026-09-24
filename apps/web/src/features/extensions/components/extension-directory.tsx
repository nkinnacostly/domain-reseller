import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import type { Directory, DirectoryGroup } from '../lib/directory'

const CHIP =
  'inline-flex min-h-11 items-center rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:border-brand-ink hover:text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-brand-subtle'

function Chips({ tlds, label }: { tlds: string[]; label: string }) {
  return (
    <ul aria-label={label} className="mt-4 flex flex-wrap gap-2">
      {tlds.map((tld) => (
        <li key={tld}>
          <Link href={`/domains/${tld}`} className={CHIP}>
            .{tld}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Section({
  id,
  title,
  intro,
  groups,
}: {
  id: string
  title: string
  intro: string
  groups: DirectoryGroup[]
}) {
  if (groups.length === 0) return null
  return (
    <section aria-labelledby={id} className="mt-14">
      <h2 id={id} className="text-2xl font-bold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-pretty text-muted-foreground">{intro}</p>
      <div className="mt-6 space-y-8">
        {groups.map((group) => (
          <div key={group.letter}>
            <h3 className="text-sm font-semibold text-muted-foreground">{group.letter}</h3>
            <Chips tlds={group.tlds} label={`${title}: ${group.letter}`} />
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * Every extension we sell, each linking to its own page (FR-PUB1). Plain
 * server-rendered links: the pricing table shows its rows 40 at a time, so
 * without this list most extension pages had no link a crawler could follow.
 */
export function ExtensionDirectory({ directory }: { directory: Directory }) {
  return (
    <Container className="py-12 sm:py-16">
      {directory.popular.length > 0 ? (
        <section aria-labelledby="directory-popular">
          <h2 id="directory-popular" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Popular in Nigeria
          </h2>
          <Chips tlds={directory.popular} label="Popular extensions" />
        </section>
      ) : null}

      <Section
        id="directory-generic"
        title="Generic extensions"
        intro="Run under ICANN’s rules rather than a country’s: .com, .org, .app and the rest."
        groups={directory.generic}
      />
      <Section
        id="directory-country"
        title="Country and regional extensions"
        intro="Each run by its country’s registry, which sets its own rules. An extension’s page says who can register it."
        groups={directory.country}
      />
    </Container>
  )
}
