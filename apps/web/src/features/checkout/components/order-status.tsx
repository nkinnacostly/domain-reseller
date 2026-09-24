import { cn } from '@/lib/utils'
import type { OrderKind } from '../lib/progress'

const LABELS: Record<string, { label: string; tone: string }> = {
  awaiting_payment: { label: 'Awaiting payment', tone: 'bg-muted text-foreground' },
  paid: { label: 'Paid — registration queued', tone: 'bg-accent/10 text-foreground' },
  provisioning: { label: 'Registering', tone: 'bg-accent/10 text-foreground' },
  completed: { label: 'Completed', tone: 'bg-accent/10 text-foreground' },
  partially_failed: { label: 'Partly failed', tone: 'bg-destructive/10 text-foreground' },
  failed: { label: 'Failed', tone: 'bg-destructive/10 text-foreground' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted text-foreground' },
}

const RENEWAL_LABELS: Record<string, { label: string; tone: string }> = {
  ...LABELS,
  paid: { label: 'Paid — renewal queued', tone: 'bg-accent/10 text-foreground' },
  provisioning: { label: 'Renewing', tone: 'bg-accent/10 text-foreground' },
}

export function OrderStatus({
  status,
  kind = 'register',
  className,
}: {
  status: string
  kind?: OrderKind
  className?: string
}) {
  const entry = (kind === 'renew' ? RENEWAL_LABELS : LABELS)[status] ?? {
    label: status,
    tone: 'bg-muted text-foreground',
  }
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
