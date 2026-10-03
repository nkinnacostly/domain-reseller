import { Check } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

export type Chip = { value: string; label: string; count?: number }

/**
 * Status filters as links, so the URL holds the filter (ADMIN-SPEC §5.2). A
 * chosen chip says so with a tick and `aria-current`, not colour alone (S8);
 * counts sit inside each link's name. Only the press animates
 * (`transition-transform`): a chip keeps its element across a client
 * navigation, and a colour fading in would be read half-way — by axe, which
 * once failed on the contrast, and by a person.
 */
export function FilterChips({
  label,
  chips,
  selected,
  href,
  allHref,
}: {
  label: string
  chips: Chip[]
  selected: readonly string[]
  /** The link that toggles one chip. */
  href: (value: string) => string
  /** The link that clears every chip. */
  allHref: string
}) {
  const none = selected.length === 0
  return (
    <nav aria-label={label} className="relative -mx-1 overflow-x-auto px-1 py-1">
      <ul className="flex min-w-max gap-2">
        <li>
          <ChipLink href={allHref} current={none}>
            All
          </ChipLink>
        </li>
        {chips.map((chip) => {
          const current = selected.includes(chip.value)
          return (
            <li key={chip.value}>
              <ChipLink href={href(chip.value)} current={current}>
                {chip.count !== undefined ? `${chip.label} (${chip.count})` : chip.label}
              </ChipLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function ChipLink({
  href,
  current,
  children,
}: {
  href: string
  current: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={current ? 'true' : undefined}
      data-current={current ? 'true' : undefined}
      className={cn(
        'group inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
        'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
        FOCUS,
      )}
    >
      {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
      {children}
    </Link>
  )
}
