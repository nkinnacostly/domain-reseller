import {
  CreditCard,
  GlobeHemisphereEast,
  LockKey,
  MagnifyingGlass,
  RocketLaunch,
  SealCheck,
} from '@phosphor-icons/react/ssr'
import { BrandPanel, FloatingIcon } from '@/components/layout/page-hero'
import { Container } from '@/components/layout/site-shell'
import { DomainSearch } from '@/features/search/components/domain-search'
import { PhoneFrame } from './phone-frame'
import { DomainsScreen, type Quote } from './phone-screens'

/**
 * Icons floating round the headline. Decorative, and only from `lg` up: below
 * that the headline fills the width and they would sit on the text.
 */
const ICONS = [
  { icon: MagnifyingGlass, className: 'top-[30%] left-[4%] size-[4.5rem] -rotate-6', delay: '0s' },
  { icon: CreditCard, className: 'top-[62%] left-[0%] size-16 rotate-6', delay: '1.2s' },
  { icon: RocketLaunch, className: 'top-[92%] left-[9%] size-14 -rotate-3', delay: '2.4s' },
  {
    icon: GlobeHemisphereEast,
    className: 'top-[28%] right-[4%] size-[4.5rem] rotate-6',
    delay: '0.6s',
  },
  { icon: LockKey, className: 'top-[60%] right-[0%] size-16 -rotate-6', delay: '1.8s' },
  { icon: SealCheck, className: 'top-[90%] right-[9%] size-14 rotate-3', delay: '3s' },
] as const

/** The home page's hero: the shared blue panel, centred, with the product below. */
export function Hero({
  extensionCount,
  lead,
  host,
}: {
  extensionCount: number | null
  lead: Quote | null
  host: string | null
}) {
  return (
    <BrandPanel
      decoration={
        <div className="absolute bottom-0 left-1/2 aspect-square w-[44rem] -translate-x-1/2 translate-y-[62%] rounded-full bg-brand-arc/55 sm:w-[64rem] sm:translate-y-[68%]" />
      }
    >
      {/* Room at the top for the header. */}
      <Container className="relative pt-28 sm:pt-36 lg:pt-40">
        {/* Inset by the Container's gutter, so no icon crosses the panel edge. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-10 inset-y-0 hidden select-none lg:block"
        >
          {ICONS.map((icon) => (
            <FloatingIcon key={icon.delay} {...icon} />
          ))}
        </div>

        <div className="relative mx-auto max-w-3xl text-center">
          <h1 className="text-[2.5rem] leading-[1.06] font-bold tracking-[-0.02em] text-balance sm:text-5xl lg:text-[4rem]">
            The domain you want, priced in naira
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-brand-muted-foreground sm:text-lg">
            {extensionCount
              ? `Search ${extensionCount.toLocaleString('en-NG')} extensions, from .com to .africa.`
              : 'Search hundreds of extensions.'}{' '}
            The renewal price sits next to the first-year price — every time, on every screen.
          </p>
          <div className="mx-auto mt-9 max-w-2xl text-left">
            <DomainSearch />
          </div>
        </div>
      </Container>

      {/* The product, peeking up from the panel's bottom edge. */}
      <div className="relative mt-14 h-[21rem] sm:mt-16 sm:h-[25rem]">
        <PhoneFrame testId="hero-phone" className="absolute top-0 left-1/2 -translate-x-1/2">
          <DomainsScreen lead={lead} host={host} />
        </PhoneFrame>
      </div>
    </BrandPanel>
  )
}
