import { Check, CircleCheck, CreditCard, Landmark, Search, Smartphone } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The screens inside the home page's phone mockups. Each one is a simplified
 * copy of a real screen — search results, checkout, nameservers, the domain
 * list — with the same labels the app uses. Prices are live: the page passes
 * them in from the catalogue (N5b), and every price carries its renewal (N8).
 */

/** A formatted quote for one extension, from the live catalogue. */
export type Quote = { tld: string; firstYear: string; renewal: string }

const EXAMPLE = 'getpaid'
const DASH = '—'

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </p>
  )
}

function FakeButton({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-9 place-items-center rounded-full bg-brand text-xs font-medium text-brand-foreground">
      {children}
    </div>
  )
}

/** Sits on the blue card, so it is white rather than the app's green pill. */
function ActivePill() {
  return (
    <span className="shrink-0 rounded-full bg-brand-foreground px-2 py-0.5 text-[0.625rem] font-semibold text-brand">
      Active
    </span>
  )
}

/** The hero: what you end up with — your domain, pointed and protected. */
export function DomainsScreen({ lead, host }: { lead: Quote | null; host: string | null }) {
  const tld = lead?.tld ?? 'com'
  const rows = [
    { label: 'Nameservers', value: host ?? 'Your host' },
    { label: 'Transfer lock', value: 'On' },
    { label: 'Contact privacy', value: 'On' },
    { label: 'Two-factor sign-in', value: 'On' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[0.625rem] text-muted-foreground">1 domain</p>
          <p className="text-base font-semibold text-foreground">Your domains</p>
        </div>
        <span className="grid size-8 place-items-center rounded-full bg-brand-subtle text-[0.6875rem] font-semibold text-brand-ink">
          GP
        </span>
      </div>

      <div className="mt-4 rounded-2xl bg-brand p-4 text-brand-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-lg font-bold tracking-tight">
            {EXAMPLE}.{tld}
          </span>
          <ActivePill />
        </div>
        <p className="mt-3 text-[0.625rem] text-brand-muted-foreground">Renews at</p>
        <p className="text-xl font-bold tracking-tight">{lead ? `${lead.renewal}/yr` : DASH}</p>
      </div>

      <ul className="mt-4 divide-y divide-border rounded-2xl border border-border">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-2 px-3 py-2.5">
            <span className="text-[0.6875rem] text-muted-foreground">{row.label}</span>
            <span className="flex items-center gap-1 text-[0.6875rem] font-semibold text-foreground">
              <CircleCheck className="size-3 text-status-active" />
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Step 1: a search, with both prices on every result. */
export function SearchScreen({ lead, more }: { lead: Quote | null; more: Quote[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-2 text-xs text-foreground">
        <Search className="size-3.5 text-muted-foreground" />
        {EXAMPLE}
      </div>

      <div data-testid="search-quote" className="mt-4 rounded-2xl border border-border p-3">
        <div className="flex items-center gap-1.5">
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-status-active text-status-active-foreground">
            <Check className="size-2.5" strokeWidth={3} />
          </span>
          <span className="truncate text-sm font-semibold text-foreground">
            {EXAMPLE}.{lead?.tld ?? 'com'}
          </span>
          <span className="ml-auto shrink-0 rounded-full bg-brand-subtle px-2 py-0.5 text-[0.625rem] font-medium text-brand-ink">
            Available
          </span>
        </div>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            <p className="text-[0.625rem] text-muted-foreground">First year</p>
            <p className="text-lg font-bold tracking-tight text-foreground">
              {lead?.firstYear ?? DASH}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[0.625rem] text-muted-foreground">Renews at</p>
            <p className="text-xs font-semibold text-foreground">
              {lead ? `${lead.renewal}/yr` : DASH}
            </p>
          </div>
        </div>
        <div className="mt-3">
          <FakeButton>Add to cart</FakeButton>
        </div>
      </div>

      {more.length > 0 ? (
        <>
          <div className="mt-5">
            <Eyebrow>More extensions</Eyebrow>
          </div>
          <ul className="mt-1 divide-y divide-border">
            {more.map((quote) => (
              <li key={quote.tld} className="flex items-center justify-between gap-2 py-2.5">
                <span className="truncate text-xs font-medium text-foreground">
                  {EXAMPLE}.{quote.tld}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs font-semibold text-foreground">
                    {quote.firstYear}
                  </span>
                  <span className="block text-[0.625rem] text-muted-foreground">
                    renews {quote.renewal}/yr
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

/** Step 2: checkout, with VAT as its own line — as the real checkout shows it. */
export function CheckoutScreen({
  lead,
  vat,
}: {
  lead: Quote | null
  vat: { pct: number; amount: string; total: string } | null
}) {
  const methods = [
    { icon: CreditCard, label: 'Card' },
    { icon: Landmark, label: 'Transfer' },
    { icon: Smartphone, label: 'USSD' },
  ]

  return (
    <div>
      <p className="text-base font-semibold text-foreground">Checkout</p>

      <div className="mt-4 rounded-2xl border border-border p-3">
        <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
          <span className="truncate">
            {EXAMPLE}.{lead?.tld ?? 'com'}
          </span>
          <span>{lead?.firstYear ?? DASH}</span>
        </div>
        <p className="mt-1 text-[0.625rem] text-muted-foreground">
          1 year · renews at {lead ? `${lead.renewal}/yr` : DASH}
        </p>
      </div>

      <div className="mt-4 space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="text-foreground">{lead?.firstYear ?? DASH}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">VAT{vat ? ` (${vat.pct}%)` : ''}</span>
          <span className="text-foreground">{vat?.amount ?? DASH}</span>
        </div>
        <div className="flex justify-between border-border border-t pt-2 font-semibold text-foreground">
          <span>Total</span>
          <span>{vat?.total ?? DASH}</span>
        </div>
      </div>

      <div className="mt-5">
        <Eyebrow>Pay with</Eyebrow>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {methods.map((method) => (
          <div
            key={method.label}
            className="flex flex-col items-center gap-1 rounded-xl border border-border py-2 text-[0.625rem] text-foreground"
          >
            <method.icon className="size-3.5 text-brand-ink" />
            {method.label}
          </div>
        ))}
      </div>

      <div className="mt-5">
        <FakeButton>Pay {vat?.total ?? ''}</FakeButton>
      </div>
      <p className="mt-2 text-center text-[0.625rem] text-muted-foreground">
        Paid through Flutterwave
      </p>
    </div>
  )
}

/** Step 3: pick a host from the verified presets, then see what resolvers see. */
export function NameserverScreen({ lead, hosts }: { lead: Quote | null; hosts: string[] }) {
  const options = hosts.slice(0, 4)
  const chosen = options[0]

  return (
    <div>
      <p className="text-[0.625rem] text-muted-foreground">
        {EXAMPLE}.{lead?.tld ?? 'com'}
      </p>
      <p className="text-base font-semibold text-foreground">Nameservers</p>

      <div className="mt-4">
        <Eyebrow>Where is your site hosted?</Eyebrow>
      </div>
      <ul className="mt-2 space-y-1.5">
        {[...options, 'Somewhere else'].map((name) => {
          const selected = name === chosen
          return (
            <li
              key={name}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs text-foreground',
                selected ? 'border-brand-ink bg-brand-subtle font-semibold' : 'border-border',
              )}
            >
              <span
                className={cn(
                  'size-3 shrink-0 rounded-full border',
                  selected ? 'border-[3.5px] border-brand-ink' : 'border-muted-foreground',
                )}
              />
              <span className="truncate">{name}</span>
            </li>
          )
        })}
      </ul>

      <div className="mt-4">
        <FakeButton>Save nameservers</FakeButton>
      </div>

      {chosen ? (
        <div className="mt-4 rounded-xl border border-border p-3">
          <Eyebrow>What public resolvers see</Eyebrow>
          <p className="mt-1.5 flex items-center gap-1.5 text-[0.6875rem] font-semibold text-foreground">
            <CircleCheck className="size-3.5 shrink-0 text-status-active" />
            {chosen}’s nameservers
          </p>
        </div>
      ) : null}
    </div>
  )
}
