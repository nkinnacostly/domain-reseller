import { cn } from '@/lib/utils'

/** Sample and test rows are always labelled, so nobody mistakes them for real domains. */
export function DomainBadges({
  source,
  testMode,
  className,
}: {
  source: string
  testMode: boolean
  className?: string
}) {
  if (source !== 'demo' && !testMode) return null
  return (
    <span
      className={cn(
        'inline-block rounded-full border border-border bg-muted px-2 py-0.5 text-[0.6875rem] font-medium text-foreground',
        className,
      )}
    >
      {source === 'demo' ? 'Demo' : 'Test order'}
    </span>
  )
}

/** A quiet note in the panel: a lead that says what is true, then the detail. */
export function PanelNote({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-muted/60 px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
      <span className="font-medium text-foreground">{title}</span>
      {children ? <> {children}</> : null}
    </p>
  )
}
