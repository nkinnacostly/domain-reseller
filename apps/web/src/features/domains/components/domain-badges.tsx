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

/** The one note every registry-side control carries until the connection is on. */
export function NotConnectedNote({ children }: { children?: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-muted/60 px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
      <span className="font-medium text-foreground">Not connected to the registry yet.</span>{' '}
      {children ?? 'This will work once domain registration is switched on.'}
    </p>
  )
}
