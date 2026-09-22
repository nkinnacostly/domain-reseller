import { Container } from '@/components/layout/site-shell'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * Facts, not adjectives. Every number is read from the live catalogue, so it
 * cannot drift from what we actually sell — pausing an extension changes the
 * count here without a deploy.
 */
export async function StatsStrip() {
  const priced = await getPricedCatalogue()
  const lead = priced?.featured[0]

  const stats = [
    priced && {
      value: priced.tlds.length.toLocaleString('en-NG'),
      label: 'Extensions available',
    },
    priced && {
      value: `${Math.max(...priced.tlds.map((t) => t.maxPeriod))} years`,
      label: 'Longest registration term',
    },
    lead && {
      value: `${lead.redemptionDays} days`,
      label: `To recover an expired .${lead.tld}`,
    },
    { value: '0', label: 'Hidden fees at checkout' },
  ].filter((stat): stat is { value: string; label: string } => Boolean(stat))

  return (
    <section aria-label="At a glance" className="border-border/70 border-y bg-muted/40">
      <Container className="py-8 sm:py-10">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
          {stats.map((stat) => (
            // flex-col-reverse puts the value above its label visually while
            // keeping dt before dd in the DOM, so the label is stated once.
            <div key={stat.label} className="flex flex-col-reverse gap-1">
              <dt className="text-sm text-muted-foreground">{stat.label}</dt>
              <dd className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  )
}
