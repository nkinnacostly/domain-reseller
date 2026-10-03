import { cn } from '@/lib/utils'

export type DlItem = { label: string; value: React.ReactNode; wide?: boolean }

/** A record's facts as a description list: one column on phones, more as room allows. */
export function DlGrid({ items, className }: { items: DlItem[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-2 xl:col-span-3')}>
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 break-words text-foreground">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
