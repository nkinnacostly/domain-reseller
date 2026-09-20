import { Container } from '@/components/layout/site-shell'

/**
 * Facts, not adjectives. Every number here is verified against the supplier
 * catalogue (see apps/gateway/scripts/verify-supplier.ts) — do not inflate them.
 */
const STATS = [
  { value: '700+', label: 'Extensions available' },
  { value: '4', label: 'Nigerian .ng extensions' },
  { value: '30 days', label: 'Redemption grace period' },
  { value: '0', label: 'Hidden fees at checkout' },
] as const

export function StatsStrip() {
  return (
    <section aria-label="At a glance" className="border-border/70 border-y bg-muted/40">
      <Container className="py-8 sm:py-10">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
          {STATS.map((stat) => (
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
