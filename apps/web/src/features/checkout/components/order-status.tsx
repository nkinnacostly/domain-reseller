import { cn } from '@/lib/utils'

const LABELS: Record<string, { label: string; tone: string }> = {
  awaiting_payment: { label: 'Awaiting payment', tone: 'bg-muted text-foreground' },
  paid: { label: 'Paid — registration queued', tone: 'bg-accent/10 text-foreground' },
  provisioning: { label: 'Registering', tone: 'bg-accent/10 text-foreground' },
  completed: { label: 'Completed', tone: 'bg-accent/10 text-foreground' },
  partially_failed: { label: 'Partly failed', tone: 'bg-destructive/10 text-foreground' },
  failed: { label: 'Failed', tone: 'bg-destructive/10 text-foreground' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted text-foreground' },
}

export function OrderStatus({ status, className }: { status: string; className?: string }) {
  const entry = LABELS[status] ?? { label: status, tone: 'bg-muted text-foreground' }
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium',
        entry.tone,
        className,
      )}
    >
      {entry.label}
    </span>
  )
}
