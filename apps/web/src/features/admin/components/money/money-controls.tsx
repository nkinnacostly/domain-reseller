import { Check } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GRAIN_LABEL, GRAINS, grainHref, type MoneyParams } from '@/features/admin/lib/money-params'
import { cn } from '@/lib/utils'

const CHIP =
  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]'

const FIELD = 'h-11 rounded-full bg-background px-4 text-foreground dark:bg-background'

/**
 * The page's dates and grain, both in the URL (docs/ADMIN-SPEC.md §5.2 B7).
 * Grains are links that keep the dates; the chosen one says so with a tick
 * and `aria-current`, not colour alone (S8, S13). The dates are a GET form,
 * so the address holds them and the overview's `?from=&to=` links land here.
 */
export function MoneyControls({ params }: { params: MoneyParams }) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <form
        action="/admin/money"
        method="get"
        aria-label="Dates"
        className="grid grid-cols-1 gap-3 min-[26rem]:grid-cols-[1fr_1fr_auto] min-[26rem]:items-end"
      >
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="money-from" className="text-sm text-muted-foreground">
            From
          </label>
          <Input
            id="money-from"
            type="date"
            name="from"
            required
            defaultValue={params.from}
            className={FIELD}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="money-to" className="text-sm text-muted-foreground">
            To
          </label>
          <Input
            id="money-to"
            type="date"
            name="to"
            required
            defaultValue={params.to}
            className={FIELD}
          />
        </div>
        {params.grainChosen ? <input type="hidden" name="grain" value={params.grain} /> : null}
        <Button
          type="submit"
          className="h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/90 active:scale-[0.98]"
        >
          Show
        </Button>
      </form>

      <nav aria-label="Group by">
        <ul className="flex flex-wrap gap-2">
          {GRAINS.map((grain) => {
            const current = grain === params.grain
            return (
              <li key={grain}>
                <Link
                  href={grainHref(params, grain)}
                  scroll={false}
                  aria-current={current ? 'true' : undefined}
                  data-current={current ? 'true' : undefined}
                  className={cn(
                    CHIP,
                    'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:font-semibold data-[current=true]:text-brand-foreground',
                    FOCUS,
                  )}
                >
                  {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                  {GRAIN_LABEL[grain]}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
