import { GlobeHemisphereEast } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/site-shell'
import { DomainSearch } from '@/features/search/components/domain-search'
import { cn } from '@/lib/utils'

/** Where the extension chips orbit the globe. Which extensions: the catalogue's featured list. */
const ORBIT = [
  'top-[6%] left-[14%] rotate-[-8deg]',
  'top-[10%] right-[6%] rotate-[6deg]',
  'bottom-[12%] left-[4%] rotate-[5deg]',
  'bottom-[4%] right-[16%] rotate-[-5deg]',
] as const

export function FinalCta({ tlds }: { tlds: string[] }) {
  return (
    <section aria-labelledby="final-cta-heading">
      <Container className="py-16 sm:py-24">
        <div className="relative overflow-hidden rounded-[2rem] bg-brand px-6 py-12 text-brand-foreground sm:rounded-[2.5rem] sm:px-12 sm:py-16 lg:px-16">
          <div
            aria-hidden="true"
            // Behind the globe only; over the text it would cost contrast.
            className="absolute -right-24 -bottom-40 hidden size-[28rem] rounded-full bg-brand-arc/55 lg:block"
          />

          <div className="relative grid items-center gap-10 lg:grid-cols-[1.3fr_1fr]">
            <div>
              <h2
                id="final-cta-heading"
                className="text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
              >
                Find the name before someone else does
              </h2>
              <p className="mt-4 max-w-lg text-pretty text-brand-muted-foreground">
                Good domains go quickly. Check yours — it takes a few seconds and costs nothing to
                look.
              </p>
              <div className="mt-8 max-w-2xl">
                <DomainSearch formLabel="Domain search, end of page" />
              </div>
            </div>

            <div
              aria-hidden="true"
              className="relative mx-auto hidden aspect-square w-full max-w-[20rem] select-none lg:block"
            >
              <div className="absolute inset-[18%] grid place-items-center rounded-full bg-brand-foreground shadow-[0_30px_60px_-24px_rgb(0_0_0/0.45)]">
                <GlobeHemisphereEast weight="duotone" className="size-1/2 text-brand" />
              </div>
              {tlds.slice(0, ORBIT.length).map((tld, index) => (
                <span
                  key={tld}
                  className={cn(
                    'absolute rounded-full bg-brand-foreground px-4 py-2 text-sm font-bold text-brand shadow-[0_14px_30px_-12px_rgb(0_0_0/0.4)]',
                    ORBIT[index],
                  )}
                >
                  .{tld}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Container>
    </section>
  )
}
