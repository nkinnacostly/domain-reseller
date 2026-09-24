import { Container } from '@/components/layout/site-shell'
import {
  describeKind,
  type ExtensionFacts,
  type ExtensionPrices,
  eligibilityText,
  icannFeeText,
  lengthText,
  periodText,
} from '../lib/extension'

/**
 * The rules for an extension, as the catalogue records them (FR-PUB1). A rule
 * the catalogue does not know yet — name length, until the sync fills it — is
 * left out rather than guessed.
 */
export function ExtensionDetails({
  facts,
  prices,
}: {
  facts: ExtensionFacts
  prices: ExtensionPrices | null
}) {
  const { tld } = facts
  const length = lengthText(facts.minChars, facts.maxChars)

  const rows = [
    { label: 'Registration period', value: `${periodText(facts.minPeriod, facts.maxPeriod)}.` },
    length ? { label: 'Name length', value: `${length}.` } : null,
    { label: 'ICANN fee', value: icannFeeText(tld, facts.isCountryCode) },
    { label: 'Eligibility', value: eligibilityText(tld, facts.requiresExtraFields) },
    prices
      ? {
          label: 'Transfers in',
          value: prices.transfer
            ? `Yes, for ${prices.transfer}, then ${prices.renew} a year.`
            : `We can't currently transfer .${tld} domains in.`,
        }
      : null,
  ].filter((row): row is { label: string; value: string } => row !== null)

  return (
    <section aria-labelledby="extension-details-heading">
      <Container>
        <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-10 lg:p-14">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
            <div className="max-w-xl">
              <h2
                id="extension-details-heading"
                className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
              >
                About .{tld}
              </h2>
              {facts.tagline ? (
                <p className="mt-4 text-lg font-medium text-pretty text-foreground">
                  {facts.tagline.replace(/[.!?]+$/, '')}.
                </p>
              ) : null}
              <p className="mt-4 text-pretty text-muted-foreground">
                {describeKind(tld, facts.isCountryCode)}
              </p>
            </div>

            <dl className="divide-y divide-brand-subtle-border rounded-3xl bg-background px-6 sm:px-8">
              {rows.map((row) => (
                <div key={row.label} className="grid gap-1 py-5 sm:grid-cols-[11rem_1fr] sm:gap-6">
                  <dt className="font-semibold text-foreground">{row.label}</dt>
                  <dd className="text-pretty text-sm/6 text-muted-foreground sm:text-base/7">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Container>
    </section>
  )
}
